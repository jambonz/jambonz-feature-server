const Task = require('./task');
const {
  TaskName,
  TaskPreconditions,
  GoogleTranscriptionEvents,
  AwsTranscriptionEvents
} = require('../utils/constants');

class TaskTranscribe extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.transcriptionHook = this.data.transcriptionHook;
    this.earlyMedia = this.data.earlyMedia === true || (parentTask && parentTask.earlyMedia);

    const recognizer = this.data.recognizer;
    this.vendor = recognizer.vendor;
    this.language = recognizer.language;
    this.interim = !!recognizer.interim;
    this.separateRecognitionPerChannel = recognizer.separateRecognitionPerChannel;

    /* google-specific options */
    this.hints = recognizer.hints || [];
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
  }

  get name() { return TaskName.Transcribe; }

  async exec(cs, ep, parentTask) {
    super.exec(cs);
    this.ep = ep;
    if ('default' === this.vendor || !this.vendor) this.vendor = cs.speechRecognizerVendor;
    if ('default' === this.language || !this.language) this.language = cs.speechRecognizerLanguage;
    try {
      await this._startTranscribing(ep);
      await this.awaitTaskDone();
    } catch (err) {
      this.logger.info(err, 'TaskTranscribe:exec - error');
    }
    ep.removeCustomEventListener(GoogleTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(GoogleTranscriptionEvents.NoAudioDetected);
    ep.removeCustomEventListener(GoogleTranscriptionEvents.MaxDurationExceeded);
    ep.removeCustomEventListener(AwsTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(AwsTranscriptionEvents.NoAudioDetected);
    ep.removeCustomEventListener(AwsTranscriptionEvents.MaxDurationExceeded);
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

  async _startTranscribing(ep) {
    const opts = {};

    ep.addCustomEventListener(GoogleTranscriptionEvents.Transcription, this._onTranscription.bind(this, ep));
    ep.addCustomEventListener(GoogleTranscriptionEvents.NoAudioDetected, this._onNoAudio.bind(this, ep));
    ep.addCustomEventListener(GoogleTranscriptionEvents.MaxDurationExceeded,
      this._onMaxDurationExceeded.bind(this, ep));
    ep.addCustomEventListener(AwsTranscriptionEvents.Transcription, this._onTranscription.bind(this, ep));
    ep.addCustomEventListener(AwsTranscriptionEvents.NoAudioDetected, this._onNoAudio.bind(this, ep));
    ep.addCustomEventListener(AwsTranscriptionEvents.MaxDurationExceeded,
      this._onMaxDurationExceeded.bind(this, ep));

    if (this.vendor === 'google') {
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
      if (this.hints.length > 1) opts.GOOGLE_SPEECH_HINTS = this.hints.join(',');
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

      Object.assign(opts, {
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
        AWS_REGION: process.env.AWS_REGION
      });

      await ep.set(opts)
        .catch((err) => this.logger.info(err, 'TaskTranscribe:_startTranscribing with aws'));
    }
    await this._transcribe(ep);
  }

  async _transcribe(ep) {
    await ep.startTranscription({
      vendor: this.vendor,
      interim: this.interim ? true : false,
      language: this.language,
      channels: this.separateRecognitionPerChannel ? 2 : 1
    });
  }

  _onTranscription(ep, evt) {
    this.logger.debug(evt, 'TaskTranscribe:_onTranscription');
    this.cs.requestor.request(this.transcriptionHook, Object.assign({speech: evt}, this.cs.callInfo))
      .catch((err) => this.logger.info(err, 'TranscribeTask:_onTranscription error'));
    if (this.killed) {
      this.logger.debug('TaskTranscribe:_onTranscription exiting after receiving final transcription');
      this._clearTimer();
      this.notifyTaskDone();
    }
  }

  _onNoAudio(ep) {
    this.logger.debug('TaskTranscribe:_onNoAudio restarting transcription');
    this._transcribe(ep);
  }

  _onMaxDurationExceeded(ep) {
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
