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
  constructor(logger, opts) {
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
  }

  get name() { return TaskName.Gather; }

  get earlyMedia() {
    return (this.sayTask && this.sayTask.earlyMedia) ||
      (this.playTask && this.playTask.earlyMedia);
  }

  async exec(cs, ep) {
    await super.exec(cs);
    this.ep = ep;
    if ('default' === this.vendor || !this.vendor) this.vendor = cs.speechRecognizerVendor;
    if ('default' === this.language || !this.language) this.language = cs.speechRecognizerLanguage;

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
        await this._initSpeech(ep);
        this._startTranscribing(ep);
      }

      if (this.input.includes('digits')) {
        ep.on('dtmf', this._onDtmf.bind(this, ep));
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
    this._killAudio();
    this._resolve('killed');
  }

  _onDtmf(ep, evt) {
    this.logger.debug(evt, 'TaskGather:_onDtmf');
    if (evt.dtmf === this.finishOnKey) this._resolve('dtmf-terminator-key');
    else {
      this.digitBuffer += evt.dtmf;
      if (this.digitBuffer.length === this.numDigits) this._resolve('dtmf-num-digits');
    }
    this._killAudio();
  }

  async _initSpeech(ep) {
    const opts = {};

    if ('google' === this.vendor) {
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
    }
    else {
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
    }
    this.logger.debug(`setting freeswitch vars ${JSON.stringify(opts)}`);
    await ep.set(opts)
      .catch((err) => this.logger.info(err, 'Error setting channel variables'));

    ep.addCustomEventListener(GoogleTranscriptionEvents.Transcription, this._onTranscription.bind(this, ep));
    ep.addCustomEventListener(AwsTranscriptionEvents.Transcription, this._onTranscription.bind(this, ep));
    ep.addCustomEventListener(GoogleTranscriptionEvents.EndOfUtterance, this._onEndOfUtterance.bind(this, ep));
  }

  _startTranscribing(ep) {
    ep.startTranscription({
      vendor: this.vendor,
      language: this.language,
      interim: this.partialResultCallback ? true : false,
    }).catch((err) => this.logger.error(err, 'TaskGather:_startTranscribing error'));
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

  _killAudio() {
    if (this.sayTask && !this.sayTask.killed) {
      this.sayTask.removeAllListeners('playDone');
      this.sayTask.kill();
    }
    if (this.playTask && !this.playTask.killed) {
      this.playTask.removeAllListeners('playDone');
      this.playTask.kill();
    }
  }

  _onTranscription(ep, evt) {
    if ('aws' === this.vendor && Array.isArray(evt) && evt.length > 0) evt = evt[0];
    this.logger.debug(evt, 'TaskGather:_onTranscription');
    const final = evt.is_final;
    if (final) this._resolve('speech', evt);
    else if (this.partialResultHook) {
      this.cs.requestor.request(this.partialResultHook,  Object.assign({speech: evt}, this.cs.callInfo))
        .catch((err) => this.logger.info(err, 'GatherTask:_onTranscription error'));
    }
  }
  _onEndOfUtterance(ep, evt) {
    this.logger.info(evt, 'TaskGather:_onEndOfUtterance');
    this._startTranscribing(ep);
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
      await this.performAction({reason: 'dtmfDetected', digits: this.digitBuffer});
    }
    else if (reason.startsWith('speech')) {
      await this.performAction({reason: 'speechDetected', speech: evt});
    }
    else if (reason.startsWith('timeout')) {
      await this.performAction({reason: 'inputTimeout'});
    }
    this.notifyTaskDone();
  }
}

module.exports = TaskGather;
