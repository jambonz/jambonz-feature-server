const Task = require('./task');
const {
  TaskName,
  TaskPreconditions,
  GoogleTranscriptionEvents,
  AzureTranscriptionEvents,
  AwsTranscriptionEvents
} = require('../utils/constants');

class TaskTranscribe extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;
    this.parentTask = parentTask;

    this.transcriptionHook = this.data.transcriptionHook;
    this.earlyMedia = this.data.earlyMedia === true || (parentTask && parentTask.earlyMedia);

    const recognizer = this.data.recognizer;
    this.vendor = recognizer.vendor;
    this.language = recognizer.language;
    this.interim = !!recognizer.interim;
    this.separateRecognitionPerChannel = recognizer.separateRecognitionPerChannel;

    /* vad: if provided, we dont connect to recognizer until voice activity is detected */
    const {enable, voiceMs = 0, mode = -1} = recognizer.vad || {};
    this.vad = {enable, voiceMs, mode};

    /* google-specific options */
    this.hints = recognizer.hints || [];
    this.hintsBoost = recognizer.hintsBoost;
    this.profanityFilter = recognizer.profanityFilter;
    this.punctuation = !!recognizer.punctuation;
    this.enhancedModel = !!recognizer.enhancedModel;
    this.words = !!recognizer.words;
    this.diarization = !!recognizer.diarization;
    this.diarizationMinSpeakers = recognizer.diarizationMinSpeakers || 0;
    this.diarizationMaxSpeakers = recognizer.diarizationMaxSpeakers || 0;
    this.interactionType = recognizer.interactionType || 'unspecified';
    this.naicsCode = recognizer.naicsCode || 0;
    this.altLanguages = recognizer.altLanguages || [];

    /* aws-specific options */
    this.identifyChannels = !!recognizer.identifyChannels;
    this.vocabularyName = recognizer.vocabularyName;
    this.vocabularyFilterName = recognizer.vocabularyFilterName;
    this.filterMethod = recognizer.filterMethod;

    /* microsoft options */
    this.outputFormat = recognizer.outputFormat || 'simple';
    this.profanityOption = recognizer.profanityOption || 'raw';
    this.requestSnr = recognizer.requestSnr || false;
    this.initialSpeechTimeoutMs = recognizer.initialSpeechTimeoutMs || 0;
    this.azureServiceEndpoint = recognizer.azureServiceEndpoint;
  }

  get name() { return TaskName.Transcribe; }

  async exec(cs, ep, parentTask) {
    super.exec(cs);
    const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, cs.srf);

    this.ep = ep;
    if ('default' === this.vendor || !this.vendor) this.vendor = cs.speechRecognizerVendor;
    if ('default' === this.language || !this.language) this.language = cs.speechRecognizerLanguage;
    this.sttCredentials = cs.getSpeechCredentials(this.vendor, 'stt');

    try {
      if (!this.sttCredentials) {
        const {writeAlerts, AlertType} = cs.srf.locals;
        this.logger.info(`TaskTranscribe:exec - ERROR stt using ${this.vendor} requested but creds not supplied`);
        writeAlerts({
          account_sid: cs.accountSid,
          alert_type: AlertType.STT_NOT_PROVISIONED,
          vendor: this.vendor
        }).catch((err) => this.logger.info({err}, 'Error generating alert for no stt'));
        throw new Error('no provisioned speech credentials for TTS');
      }
      await this._startTranscribing(cs, ep);
      updateSpeechCredentialLastUsed(this.sttCredentials.speech_credential_sid)
        .catch(() => {/*already logged error */});

      await this.awaitTaskDone();
    } catch (err) {
      this.logger.info(err, 'TaskTranscribe:exec - error');
      this.parentTask && this.parentTask.emit('error', err);
    }
    ep.removeCustomEventListener(GoogleTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(GoogleTranscriptionEvents.NoAudioDetected);
    ep.removeCustomEventListener(GoogleTranscriptionEvents.MaxDurationExceeded);
    ep.removeCustomEventListener(AwsTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(AwsTranscriptionEvents.NoAudioDetected);
    ep.removeCustomEventListener(AwsTranscriptionEvents.MaxDurationExceeded);
    ep.removeCustomEventListener(AzureTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(AzureTranscriptionEvents.NoSpeechDetected);
  }

  async kill(cs) {
    super.kill(cs);
    if (this.ep.connected) {
      this.ep.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.info(err, 'Error TaskTranscribe:kill'));

      // hangup after 1 sec if we don't get a final transcription
      this._timer = setTimeout(() => this.notifyTaskDone(), 1000);
    }
    else this.notifyTaskDone();
    await this.awaitTaskDone();
  }

  async _startTranscribing(cs, ep) {
    const opts = {};

    if (this.vad.enable) {
      opts.START_RECOGNIZING_ON_VAD = 1;
      if (this.vad.voiceMs) opts.RECOGNIZER_VAD_VOICE_MS = this.vad.voiceMs;
      if (this.vad.mode >= 0 && this.vad.mode <= 3) opts.RECOGNIZER_VAD_MODE = this.vad.mode;
    }

    ep.addCustomEventListener(GoogleTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
    ep.addCustomEventListener(GoogleTranscriptionEvents.NoAudioDetected, this._onNoAudio.bind(this, cs, ep));
    ep.addCustomEventListener(GoogleTranscriptionEvents.MaxDurationExceeded,
      this._onMaxDurationExceeded.bind(this, cs, ep));
    ep.addCustomEventListener(AwsTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
    ep.addCustomEventListener(AwsTranscriptionEvents.NoAudioDetected, this._onNoAudio.bind(this, cs, ep));
    ep.addCustomEventListener(AwsTranscriptionEvents.MaxDurationExceeded,
      this._onMaxDurationExceeded.bind(this, cs, ep));
    ep.addCustomEventListener(AzureTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
    ep.addCustomEventListener(AzureTranscriptionEvents.NoSpeechDetected, this._onNoAudio.bind(this, cs, ep));

    if (this.vendor === 'google') {
      if (this.sttCredentials) opts.GOOGLE_APPLICATION_CREDENTIALS = JSON.stringify(this.sttCredentials.credentials);
      [
        ['enhancedModel', 'GOOGLE_SPEECH_USE_ENHANCED'],
        ['separateRecognitionPerChannel', 'GOOGLE_SPEECH_SEPARATE_RECOGNITION_PER_CHANNEL'],
        ['profanityFilter', 'GOOGLE_SPEECH_PROFANITY_FILTER'],
        ['punctuation', 'GOOGLE_SPEECH_ENABLE_AUTOMATIC_PUNCTUATION'],
        ['words', 'GOOGLE_SPEECH_ENABLE_WORD_TIME_OFFSETS'],
        ['diarization', 'GOOGLE_SPEECH_PROFANITY_FILTER']
      ].forEach((arr) => {
        if (this[arr[0]]) opts[arr[1]] = true;
      });
      if (this.hints.length > 1) {
        opts.GOOGLE_SPEECH_HINTS = this.hints.join(',');
        if (typeof this.hintsBoost === 'number') {
          opts.GOOGLE_SPEECH_HINTS_BOOST = this.hintsBoost;
        }
      }
      if (this.altLanguages.length > 1) opts.GOOGLE_SPEECH_ALTERNATIVE_LANGUAGE_CODES = this.altLanguages.join(',');
      if ('unspecified' !== this.interactionType) {
        opts.GOOGLE_SPEECH_METADATA_INTERACTION_TYPE = this.interactionType;

        // additionally set model if appropriate
        if ('phone_call' === this.interactionType) opts.GOOGLE_SPEECH_MODEL = 'phone_call';
        else if (['voice_search', 'voice_command'].includes(this.interactionType)) {
          opts.GOOGLE_SPEECH_MODEL = 'command_and_search';
        }
        else opts.GOOGLE_SPEECH_MODEL = 'phone_call';
      }
      else opts.GOOGLE_SPEECH_MODEL = 'phone_call';
      if (this.diarization && this.diarizationMinSpeakers > 0) {
        opts.GOOGLE_SPEECH_SPEAKER_DIARIZATION_MIN_SPEAKER_COUNT = this.diarizationMinSpeakers;
      }
      if (this.diarization && this.diarizationMaxSpeakers > 0) {
        opts.GOOGLE_SPEECH_SPEAKER_DIARIZATION_MAX_SPEAKER_COUNT = this.diarizationMaxSpeakers;
      }
      if (this.naicsCode > 0) opts.GOOGLE_SPEECH_METADATA_INDUSTRY_NAICS_CODE = this.naicsCode;

      await ep.set(opts)
        .catch((err) => this.logger.info(err, 'TaskTranscribe:_startTranscribing with google'));
    }
    else if (this.vendor === 'aws') {
      [
        ['diarization', 'AWS_SHOW_SPEAKER_LABEL'],
        ['identifyChannels', 'AWS_ENABLE_CHANNEL_IDENTIFICATION']
      ].forEach((arr) => {
        if (this[arr[0]]) opts[arr[1]] = true;
      });
      if (this.vocabularyName) opts.AWS_VOCABULARY_NAME = this.vocabularyName;
      if (this.vocabularyFilterName) {
        opts.AWS_VOCABULARY_NAME = this.vocabularyFilterName;
        opts.AWS_VOCABULARY_FILTER_METHOD = this.filterMethod || 'mask';
      }

      if (this.sttCredentials) {
        Object.assign(opts, {
          AWS_ACCESS_KEY_ID: this.sttCredentials.accessKeyId,
          AWS_SECRET_ACCESS_KEY: this.sttCredentials.secretAccessKey,
          AWS_REGION: this.sttCredentials.region
        });
      }
      else {
        Object.assign(opts, {
          AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
          AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
          AWS_REGION: process.env.AWS_REGION
        });
      }

      await ep.set(opts)
        .catch((err) => this.logger.info(err, 'TaskTranscribe:_startTranscribing with aws'));
    }
    else if (this.vendor === 'microsoft') {
      Object.assign(opts, {
        'AZURE_SUBSCRIPTION_KEY': this.sttCredentials.api_key,
        'AZURE_REGION': this.sttCredentials.region
      });
      if (this.hints && this.hints.length > 1) {
        opts.AZURE_SPEECH_HINTS = this.hints.map((h) => h.trim()).join(',');
      }
      if (this.requestSnr) opts.AZURE_REQUEST_SNR = 1;
      if (this.profanityOption !== 'raw') opts.AZURE_PROFANITY_OPTION = this.profanityOption;
      if (this.initialSpeechTimeoutMs > 0) opts.AZURE_INITIAL_SPEECH_TIMEOUT_MS = this.initialSpeechTimeoutMs;
      if (this.outputFormat !== 'simple') opts.AZURE_USE_OUTPUT_FORMAT_DETAILED = 1;
      if (this.azureServiceEndpoint) opts.AZURE_SERVICE_ENDPOINT = this.azureServiceEndpoint;

      await ep.set(opts)
        .catch((err) => this.logger.info(err, 'TaskTranscribe:_startTranscribing with azure'));
    }
    await this._transcribe(ep);
  }

  async _transcribe(ep) {
    await ep.startTranscription({
      vendor: this.vendor,
      interim: this.interim ? true : false,
      locale: this.language,
      channels: this.separateRecognitionPerChannel ? 2 : 1
    });
  }

  _onTranscription(cs, ep, evt) {
    this.logger.debug(evt, 'TaskTranscribe:_onTranscription');
    if ('aws' === this.vendor && Array.isArray(evt) && evt.length > 0) evt = evt[0];
    if ('microsoft' === this.vendor) {
      const nbest = evt.NBest;
      const alternatives = nbest ? nbest.map((n) => {
        return {
          confidence: n.Confidence,
          transcript: n.Display
        };
      }) :
        [
          {
            transcript: evt.DisplayText
          }
        ];

      const newEvent = {
        is_final: evt.RecognitionStatus === 'Success',
        alternatives
      };
      evt = newEvent;
    }

    if (this.transcriptionHook) {
      this.cs.requestor.request('verb:hook', this.transcriptionHook, Object.assign({speech: evt}, this.cs.callInfo))
        .catch((err) => this.logger.info(err, 'TranscribeTask:_onTranscription error'));
    }
    if (this.parentTask) {
      this.parentTask.emit('transcription', evt);
    }
    if (this.killed) {
      this.logger.debug('TaskTranscribe:_onTranscription exiting after receiving final transcription');
      this._clearTimer();
      this.notifyTaskDone();
    }
  }

  _onNoAudio(cs, ep) {
    this.logger.debug('TaskTranscribe:_onNoAudio restarting transcription');
    this._transcribe(ep);
  }

  _onMaxDurationExceeded(cs, ep) {
    this.logger.debug('TaskTranscribe:_onMaxDurationExceeded restarting transcription');
    this._transcribe(ep);
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

module.exports = TaskTranscribe;
