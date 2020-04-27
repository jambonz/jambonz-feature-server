const Task = require('./task');
const {TaskName, TaskPreconditions, TranscriptionEvents} = require('../utils/constants');
const makeTask = require('./make_task');
const assert = require('assert');

class TaskGather extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    [
      'finishOnKey', 'hints', 'input', 'numDigits',
      'partialResultHook', 'profanityFilter',
      'speechTimeout', 'timeout', 'say', 'play'
    ].forEach((k) => this[k] = this.data[k]);

    this.timeout = (this.timeout || 5) * 1000;
    this.interim = this.partialResultCallback;
    if (this.data.recognizer) {
      this.language = this.data.recognizer.language || 'en-US';
      this.vendor = this.data.recognizer.vendor;
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
    ep.removeCustomEventListener(TranscriptionEvents.Transcription);
    ep.removeCustomEventListener(TranscriptionEvents.EndOfUtterance);
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
    const opts = {
      GOOGLE_SPEECH_USE_ENHANCED: true,
      GOOGLE_SPEECH_SINGLE_UTTERANCE: true,
      GOOGLE_SPEECH_MODEL: 'command_and_search'
    };
    if (this.hints) {
      Object.assign(opts, {'GOOGLE_SPEECH_HINTS': this.hints.join(',')});
    }
    if (this.profanityFilter === true) {
      Object.assign(opts, {'GOOGLE_SPEECH_PROFANITY_FILTER': true});
    }
    this.logger.debug(`setting freeswitch vars ${JSON.stringify(opts)}`);
    await ep.set(opts)
      .catch((err) => this.logger.info(err, 'Error set'));
    ep.addCustomEventListener(TranscriptionEvents.Transcription, this._onTranscription.bind(this, ep));
    ep.addCustomEventListener(TranscriptionEvents.EndOfUtterance, this._onEndOfUtterance.bind(this, ep));
  }

  _startTranscribing(ep) {
    ep.startTranscription({
      interim: this.partialResultCallback ? true : false,
      language: this.language || this.callSession.speechRecognizerLanguage
    }).catch((err) => this.logger.error(err, 'TaskGather:_startTranscribing error'));
  }

  _startTimer() {
    assert(!this._timeoutTimer);
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
    this.logger.debug(evt, 'TaskGather:_onTranscription');
    if (evt.is_final) this._resolve('speech', evt);
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
    this.logger.debug(`TaskGather:resolve with reason ${reason}`);

    this._clearTimer();
    if (reason.startsWith('dtmf')) {
      await this.performAction({digits: this.digitBuffer});
    }
    else if (reason.startsWith('speech')) {
      await this.performAction({speech: evt});
    }
    this.notifyTaskDone();
  }
}

module.exports = TaskGather;
