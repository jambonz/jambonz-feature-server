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

    const {setChannelVarsForStt, normalizeTranscription} = require('../utils/transcription-utils')(logger);
    this.setChannelVarsForStt = setChannelVarsForStt;
    this.normalizeTranscription = normalizeTranscription;

    /* vad: if provided, we dont connect to recognizer until voice activity is detected */
    const {enable, voiceMs = 0, mode = -1} = recognizer.vad || {};
    this.vad = {enable, voiceMs, mode};

    /* google-specific options */
    this.hints = recognizer.hints || [];
    this.hintsBoost = recognizer.hintsBoost;
    this.profanityFilter = recognizer.profanityFilter;
    this.punctuation = !!recognizer.punctuation;
    this.enhancedModel = !!recognizer.enhancedModel;
    this.model = recognizer.model || 'phone_call';
    this.words = !!recognizer.words;
    this.singleUtterance = recognizer.singleUtterance || false;
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
    this.azureSttEndpointId = recognizer.azureSttEndpointId;
  }

  get name() { return TaskName.Transcribe; }

  async exec(cs, {ep, ep2}) {
    super.exec(cs);
    const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, cs.srf);

    if (cs.hasGlobalSttHints) {
      const {hints, hintsBoost} = cs.globalSttHints;
      this.hints = this.hints.concat(hints);
      if (!this.hintsBoost && hintsBoost) this.hintsBoost = hintsBoost;
      this.logger.debug({hints: this.hints, hintsBoost: this.hintsBoost},
        'Transcribe:exec - applying global `sttHints');
    }
    if (cs.hasAltLanguages) {
      this.altLanguages = this.altLanguages.concat(cs.altLanguages);
      this.logger.debug({altLanguages: this.altLanguages},
        'Gather:exec - applying altLanguages');
    }
    if (cs.hasGlobalSttPunctuation) {
      this.punctuation = cs.globalSttPunctuation;
    }

    this.ep = ep;
    this.ep2 = ep2;
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
      await this._startTranscribing(cs, ep, 1);
      if (this.separateRecognitionPerChannel && ep2) {
        await this._startTranscribing(cs, ep2, 2);
      }

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
    let stopTranscription = false;
    if (this.ep?.connected) {
      stopTranscription = true;
      this.ep.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.info(err, 'Error TaskTranscribe:kill'));
    }
    if (this.separateRecognitionPerChannel && this.ep2 && this.ep2.connected) {
      stopTranscription = true;
      this.ep2.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.info(err, 'Error TaskTranscribe:kill'));
    }
    // hangup after 1 sec if we don't get a final transcription
    if (stopTranscription) this._timer = setTimeout(() => this.notifyTaskDone(), 1500);
    else this.notifyTaskDone();

    await this.awaitTaskDone();
  }

  async _startTranscribing(cs, ep, channel) {
    const opts = {};

    if (this.vad.enable) {
      opts.START_RECOGNIZING_ON_VAD = 1;
      if (this.vad.voiceMs) opts.RECOGNIZER_VAD_VOICE_MS = this.vad.voiceMs;
      if (this.vad.mode >= 0 && this.vad.mode <= 3) opts.RECOGNIZER_VAD_MODE = this.vad.mode;
    }

    ep.addCustomEventListener(GoogleTranscriptionEvents.Transcription,
      this._onTranscription.bind(this, cs, ep, channel));
    ep.addCustomEventListener(GoogleTranscriptionEvents.NoAudioDetected, this._onNoAudio.bind(this, cs, ep, channel));
    ep.addCustomEventListener(GoogleTranscriptionEvents.MaxDurationExceeded,
      this._onMaxDurationExceeded.bind(this, cs, ep, channel));
    ep.addCustomEventListener(AwsTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep, channel));
    ep.addCustomEventListener(AwsTranscriptionEvents.NoAudioDetected, this._onNoAudio.bind(this, cs, ep, channel));
    ep.addCustomEventListener(AwsTranscriptionEvents.MaxDurationExceeded,
      this._onMaxDurationExceeded.bind(this, cs, ep, channel));
    ep.addCustomEventListener(AzureTranscriptionEvents.Transcription,
      this._onTranscription.bind(this, cs, ep, channel));
    ep.addCustomEventListener(AzureTranscriptionEvents.NoSpeechDetected, this._onNoAudio.bind(this, cs, ep, channel));

    if (this.vendor === 'google') {
      this.bugname = 'google_transcribe';
      if (this.sttCredentials) opts.GOOGLE_APPLICATION_CREDENTIALS = JSON.stringify(this.sttCredentials.credentials);
      [
        ['enhancedModel', 'GOOGLE_SPEECH_USE_ENHANCED'],
        //['separateRecognitionPerChannel', 'GOOGLE_SPEECH_SEPARATE_RECOGNITION_PER_CHANNEL'],
        ['profanityFilter', 'GOOGLE_SPEECH_PROFANITY_FILTER'],
        ['punctuation', 'GOOGLE_SPEECH_ENABLE_AUTOMATIC_PUNCTUATION'],
        ['words', 'GOOGLE_SPEECH_ENABLE_WORD_TIME_OFFSETS'],
        ['singleUtterance', 'GOOGLE_SPEECH_SINGLE_UTTERANCE'],
        ['diarization', 'GOOGLE_SPEECH_PROFANITY_FILTER']
      ].forEach((arr) => {
        if (this[arr[0]]) opts[arr[1]] = true;
        else if (this[arr[0]] === false) opts[arr[1]] = false;
      });
      if (this.hints.length > 0) {
        opts.GOOGLE_SPEECH_HINTS = this.hints.join(',');
        if (typeof this.hintsBoost === 'number') {
          opts.GOOGLE_SPEECH_HINTS_BOOST = this.hintsBoost;
        }
      }
      if (this.altLanguages.length > 0) opts.GOOGLE_SPEECH_ALTERNATIVE_LANGUAGE_CODES = this.altLanguages.join(',');
      else opts.GOOGLE_SPEECH_ALTERNATIVE_LANGUAGE_CODES = '';
      if ('unspecified' !== this.interactionType) {
        opts.GOOGLE_SPEECH_METADATA_INTERACTION_TYPE = this.interactionType;
      }
      opts.GOOGLE_SPEECH_MODEL = this.model;
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
      this.bugname = 'aws_transcribe';
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
      this.bugname = 'azure_transcribe';
      const {api_key, region, use_custom_stt, custom_stt_endpoint} = this.sttCredentials;
      Object.assign(opts, {
        'AZURE_SUBSCRIPTION_KEY': api_key,
        'AZURE_REGION': region
      });
      if (this.azureSttEndpointId) {
        Object.assign(opts, {'AZURE_SERVICE_ENDPOINT_ID': this.azureSttEndpointId});
      }
      else if (use_custom_stt && custom_stt_endpoint) {
        Object.assign(opts, {'AZURE_SERVICE_ENDPOINT_ID': custom_stt_endpoint});
      }
      if (this.hints && this.hints.length > 0) {
        opts.AZURE_SPEECH_HINTS = this.hints.map((h) => h.trim()).join(',');
      }
      if (this.altLanguages.length > 0) opts.AZURE_SPEECH_ALTERNATIVE_LANGUAGE_CODES = this.altLanguages.join(',');
      else opts.AZURE_SPEECH_ALTERNATIVE_LANGUAGE_CODES = '';
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
      channels: /*this.separateRecognitionPerChannel ? 2 : */ 1,
      bugname: this.bugname
    });
  }

  _onTranscription(cs, ep, channel, evt, fsEvent) {
    // make sure this is not a transcript from answering machine detection
    const bugname = fsEvent.getHeader('media-bugname');
    if (bugname && this.bugname !== bugname) return;

    this.normalizeTranscription(evt, this.vendor, channel, this.language);

    this.logger.debug({evt}, 'TaskTranscribe:_onTranscription');

    if (evt.alternatives[0].transcript === '' && !cs.callGone && !this.killed) {
      this.logger.info({evt}, 'TaskGather:_onTranscription - got empty transcript, listen again');
      return this._transcribe(ep);
    }

    if (this.transcriptionHook) {
      const b3 = this.getTracingPropagation();
      const httpHeaders = b3 && {b3};
      this.cs.requestor.request('verb:hook', this.transcriptionHook,
        Object.assign({speech: evt}, this.cs.callInfo), httpHeaders)
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

  _onNoAudio(cs, ep, channel) {
    this.logger.debug(`TaskTranscribe:_onNoAudio restarting transcription on channel ${channel}`);
    this._transcribe(ep);
  }

  _onMaxDurationExceeded(cs, ep, channel) {
    this.logger.debug(`TaskTranscribe:_onMaxDurationExceeded restarting transcription on channel ${channel}`);
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
