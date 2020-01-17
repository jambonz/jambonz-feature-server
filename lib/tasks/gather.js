const Task = require('./task');
const {TaskName, TaskPreconditions, TranscriptionEvents} = require('../utils/constants');
const makeTask = require('./make_task');
const assert = require('assert');

class TaskGather extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    [
      'action', 'finishOnKey', 'hints', 'input', 'language', 'method', 'numDigits',
      'partialResultCallback', 'partialResultCallbackMethod', 'profanityFilter',
      'speechTimeout', 'timeout', 'say'
    ].forEach((k) => this[k] = this.data[k]);

    this.partialResultCallbackMethod = this.partialResultCallbackMethod || 'POST';
    this.method = this.method || 'POST';
    this.timeout = (this.timeout || 5) * 1000;
    this.language = this.language || 'en-US';
    this.digitBuffer = '';
    //this._earlyMedia = this.data.earlyMedia === true;

    if (this.say) {
      this.sayTask = makeTask(this.logger, {say: this.say});
    }
  }

  get name() { return TaskName.Gather; }

  get earlyMedia() {
    return (this.sayTask && this.sayTask.earlyMedia) ||
      (this.playTask && this.playTask.earlyMedia);
  }

  async exec(cs, ep) {
    this.ep = ep;
    this.actionHook = cs.actionHook;

    this.taskInProgress = true;
    try {
      if (this.sayTask) {
        this.sayTask.exec(cs, ep);  // kicked off, _not_ waiting for it to complete
        this.sayTask.on('playDone', (err) => {
          if (this.taskInProgress) this._startTimer();
        });
      }
      else this._startTimer();

      if (this.input.includes('speech')) {
        await this._initSpeech(ep);
        this._startTranscribing(ep);
      }

      if (this.input.includes('dtmf')) {
        ep.on('dtmf', this._onDtmf.bind(this, ep));
      }

      await this._waitForCompletion();
    } catch (err) {
      this.logger.error(err, 'TaskGather:exec error');
    }
    this.taskInProgress = false;
    ep.removeCustomEventListener(TranscriptionEvents.Transcription);
    ep.removeCustomEventListener(TranscriptionEvents.EndOfUtterance);
  }

  kill() {
    super.kill();
    this._killAudio();
    this._resolve('killed');
  }

  async _waitForCompletion() {
    return new Promise((resolve) => this.resolver = resolve);
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
      GOOGLE_SPEECH_MODEL: 'phone_call'
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
      language: this.language
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
    if (this.sayTask) {
      this.sayTask.kill();
      this.sayTask = null;
    }
  }

  _onTranscription(ep, evt) {
    this.logger.debug(evt, 'TaskGather:_onTranscription');
    if (evt.is_final) {
      ep.removeCustomEventListener(TranscriptionEvents.Transcription);
      ep.removeCustomEventListener(TranscriptionEvents.EndOfUtterance);
      this._resolve('speech', evt);
    }
    else if (this.partialResultCallback) {
      this.actionHook(this.partialResultCallback, 'POST', {
        Speech: evt
      });
    }
  }
  _onEndOfUtterance(ep, evt) {
    this.logger.info(evt, 'TaskGather:_onEndOfUtterance');
    this._startTranscribing(ep);
  }

  _resolve(reason, evt) {
    this.logger.debug(`TaskGather:resolve with reason ${reason}`);
    assert(this.resolver);

    if (reason.startsWith('dtmf')) {
      this.actionHook(this.action, this.method, {
        Digits: this.digitBuffer
      });
    }
    else if (reason.startsWith('speech')) {
      this.actionHook(this.action, this.method, {
        Speech: evt
      });
    }
    this._clearTimer();
    this.resolver();
  }
}

module.exports = TaskGather;
