const Task = require('./task');
const {
  TaskName,
  TaskPreconditions,
  GoogleTranscriptionEvents,
  AwsTranscriptionEvents
} = require('../utils/constants');

const makeTask = require('./make_task');
const assert = require('assert');

class TaskGather extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    [
      'finishOnKey', 'hints', 'input', 'numDigits',
      'partialResultHook',
      'speechTimeout', 'timeout', 'say', 'play'
    ].forEach((k) => this[k] = this.data[k]);

    this.timeout = (this.timeout || 5) * 1000;
    this.interim = this.partialResultCallback;
    if (this.data.recognizer) {
      const recognizer = this.data.recognizer;
      this.vendor = recognizer.vendor;
      this.language = recognizer.language;
      this.hints = recognizer.hints || [];
      this.altLanguages = recognizer.altLanguages || [];

      /* aws options */
      this.vocabularyName = recognizer.vocabularyName;
      this.vocabularyFilterName = recognizer.vocabularyFilterName;
      this.filterMethod = recognizer.filterMethod;
    }

    this.digitBuffer = '';
    this._earlyMedia = this.data.earlyMedia === true;

    if (this.say) this.sayTask = makeTask(this.logger, {say: this.say}, this);
    if (this.play) this.playTask = makeTask(this.logger, {play: this.play}, this);

    this.parentTask = parentTask;
  }

  get name() { return TaskName.Gather; }

  get earlyMedia() {
    return (this.sayTask && this.sayTask.earlyMedia) ||
      (this.playTask && this.playTask.earlyMedia);
  }

  async exec(cs, ep) {
    await super.exec(cs);
    const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, cs.srf);

    this.ep = ep;
    if ('default' === this.vendor || !this.vendor) this.vendor = cs.speechRecognizerVendor;
    if ('default' === this.language || !this.language) this.language = cs.speechRecognizerLanguage;
    this.sttCredentials = cs.getSpeechCredentials(this.vendor, 'stt');
    if (!this.sttCredentials) {
      const {writeAlerts, AlertType} = cs.srf.locals;
      this.logger.info(`TaskGather:exec - ERROR stt using ${this.vendor} requested but not creds supplied`);
      writeAlerts({
        account_sid: cs.accountSid,
        alert_type: AlertType.STT_NOT_PROVISIONED,
        vendor: this.vendor
      }).catch((err) => this.logger.info({err}, 'Error generating alert for no stt'));

      throw new Error(`no speech-to-text service credentials for ${this.vendor} have been configured`);
    }

    try {
      if (this.sayTask) {
        this.sayTask.exec(cs, ep);  // kicked off, _not_ waiting for it to complete
        this.sayTask.on('playDone', (err) => {
          if (!this.killed) this._startTimer();
        });
      }
      else if (this.playTask) {
        this.playTask.exec(cs, ep);  // kicked off, _not_ waiting for it to complete
        this.playTask.on('playDone', (err) => {
          if (!this.killed) this._startTimer();
        });
      }
      else this._startTimer();

      if (this.input.includes('speech')) {
        await this._initSpeech(cs, ep);
        this._startTranscribing(ep);
        updateSpeechCredentialLastUsed(this.sttCredentials.speech_credential_sid)
          .catch(() => {/*already logged error */});
      }

      if (this.input.includes('digits')) {
        ep.on('dtmf', this._onDtmf.bind(this, cs, ep));
      }

      await this.awaitTaskDone();
    } catch (err) {
      this.logger.error(err, 'TaskGather:exec error');
    }
    ep.removeCustomEventListener(GoogleTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(GoogleTranscriptionEvents.EndOfUtterance);
    ep.removeCustomEventListener(AwsTranscriptionEvents.Transcription);
  }

  kill(cs) {
    super.kill(cs);
    this._killAudio(cs);
    this.ep.removeAllListeners('dtmf');
    this._resolve('killed');
  }

  _onDtmf(cs, ep, evt) {
    this.logger.debug(evt, 'TaskGather:_onDtmf');
    if (evt.dtmf === this.finishOnKey) this._resolve('dtmf-terminator-key');
    else {
      this.digitBuffer += evt.dtmf;
      if (this.digitBuffer.length === this.numDigits) this._resolve('dtmf-num-digits');
    }
    this._killAudio(cs);
  }

  async _initSpeech(cs, ep) {
    const opts = {};

    if ('google' === this.vendor) {
      if (this.sttCredentials) opts.GOOGLE_APPLICATION_CREDENTIALS = JSON.stringify(this.sttCredentials.credentials);
      Object.assign(opts, {
        GOOGLE_SPEECH_USE_ENHANCED: true,
        GOOGLE_SPEECH_SINGLE_UTTERANCE: true,
        GOOGLE_SPEECH_MODEL: 'command_and_search'
      });
      if (this.hints && this.hints.length > 1) opts.GOOGLE_SPEECH_HINTS = this.hints.join(',');
      if (this.altLanguages && this.altLanguages.length > 1) {
        opts.GOOGLE_SPEECH_ALTERNATIVE_LANGUAGE_CODES = this.altLanguages.join(',');
      }
      if (this.profanityFilter === true) {
        Object.assign(opts, {'GOOGLE_SPEECH_PROFANITY_FILTER': true});
      }
      ep.addCustomEventListener(GoogleTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
      ep.addCustomEventListener(GoogleTranscriptionEvents.EndOfUtterance, this._onEndOfUtterance.bind(this, cs, ep));
    }
    else {
      if (this.vocabularyName) opts.AWS_VOCABULARY_NAME = this.vocabularyName;
      if (this.vocabularyFilterName) {
        opts.AWS_VOCABULARY_NAME = this.vocabularyFilterName;
        opts.AWS_VOCABULARY_FILTER_METHOD = this.filterMethod || 'mask';
      }
      Object.assign(opts, {
        AWS_ACCESS_KEY_ID: this.sttCredentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: this.sttCredentials.secretAccessKey,
        AWS_REGION: this.sttCredentials.region
      });
      ep.addCustomEventListener(AwsTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
    }
    await ep.set(opts)
      .catch((err) => this.logger.info(err, 'Error setting channel variables'));

  }

  _startTranscribing(ep) {
    ep.startTranscription({
      vendor: this.vendor,
      locale: this.language,
      interim: this.partialResultCallback ? true : false,
    }).catch((err) => {
      const {writeAlerts, AlertType} = this.cs.srf.locals;
      this.logger.error(err, 'TaskGather:_startTranscribing error');
      writeAlerts({
        account_sid: this.cs.accountSid,
        alert_type: AlertType.STT_FAILURE,
        vendor: this.vendor,
        detail: err.message
      });
    }).catch((err) => this.logger.info({err}, 'Error generating alert for tts failure'));
  }

  _startTimer() {
    assert(!this._timeoutTimer);
    this.logger.debug(`Gather:_startTimer: timeout ${this.timeout}`);
    this._timeoutTimer = setTimeout(() => this._resolve('timeout'), this.timeout);
  }

  _clearTimer() {
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  }

  _killAudio(cs) {
    if (this.sayTask && !this.sayTask.killed) {
      this.sayTask.removeAllListeners('playDone');
      this.sayTask.kill(cs);
      this.sayTask = null;
    }
    if (this.playTask && !this.playTask.killed) {
      this.playTask.removeAllListeners('playDone');
      this.playTask.kill(cs);
      this.playTask = null;
    }
  }

  _onTranscription(cs, ep, evt) {
    if ('aws' === this.vendor && Array.isArray(evt) && evt.length > 0) evt = evt[0];
    this.logger.debug(evt, 'TaskGather:_onTranscription');
    const final = evt.is_final;
    if (final) {
      this._resolve('speech', evt);
    }
    else if (this.partialResultHook) {
      this.cs.requestor.request(this.partialResultHook,  Object.assign({speech: evt}, this.cs.callInfo))
        .catch((err) => this.logger.info(err, 'GatherTask:_onTranscription error'));
    }
  }
  _onEndOfUtterance(cs, ep) {
    this.logger.info('TaskGather:_onEndOfUtterance');
    if (!this.resolved && !this.killed) {
      this._startTranscribing(ep);
    }
  }

  async _resolve(reason, evt) {
    if (this.resolved) return;
    this.resolved = true;
    this.logger.debug(`TaskGather:resolve with reason ${reason}`);

    if (this.ep && this.ep.connected) {
      this.ep.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.error({err}, 'Error stopping transcription'));
    }

    this._clearTimer();
    if (reason.startsWith('dtmf')) {
      await this.performAction({digits: this.digitBuffer, reason: 'dtmfDetected'});
    }
    else if (reason.startsWith('speech')) {
      if (this.parentTask) this.parentTask.emit('transcription', evt);
      else await this.performAction({speech: evt, reason: 'speechDetected'});
    }
    else if (reason.startsWith('timeout')) {
      if (this.parentTask) this.parentTask.emit('timeout', evt);
      else await this.performAction({reason: 'timeout'});
    }
    this.notifyTaskDone();
  }
}

module.exports = TaskGather;
