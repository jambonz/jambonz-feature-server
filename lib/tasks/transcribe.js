const Task = require('./task');
const {TaskName, TaskPreconditions, TranscriptionEvents} = require('../utils/constants');
const assert = require('assert');

class TaskTranscribe extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.action = this.data.action;
    this.language = this.data.language || 'en-US';
    this.vendor = this.data.vendor;
    this.interim = this.data.interim === true;
    this.mixType = this.data.mixType;
    this.earlyMedia = this.data.earlyMedia === true;

    this._completionPromise = new Promise((resolve) => this._completionResolver = resolve);
  }

  get name() { return TaskName.Transcribe; }

  async exec(cs, ep, parentTask) {
    this.ep = ep;
    this.actionHook = ep.cs.actionHook;
    this.transcribeInProgress = true;
    try {
      await this._initSpeech(ep);
      await this._startTranscribing(ep);
      await this._completionPromise;
    } catch (err) {
      this.logger.info(err, 'TaskTranscribe:exec - error');
    }
    this.transcribeInProgress = true;
    ep.removeCustomEventListener(TranscriptionEvents.Transcription);
  }

  async kill() {
    super.kill();
    if (this.ep.connected && this.transcribeInProgress) {
      this.ep.stopTranscription().catch((err) => this.logger.info(err, 'Error TaskTranscribe:kill'));

      // hangup after 1 sec if we don't get a final transcription
      this._timer = setTimeout(() => this._completionResolver(), 1000);
    }
    else {
      this._completionResolver();
    }
    await this._completionPromise;
  }

  async _initSpeech(ep) {
    const opts = {
      GOOGLE_SPEECH_USE_ENHANCED: true,
      GOOGLE_SPEECH_MODEL: 'phone_call'
    };
    if (this.hints) {
      Object.assign(opts, {'GOOGLE_SPEECH_HINTS': this.hints.join(',')});
    }
    if (this.profanityFilter === true) {
      Object.assign(opts, {'GOOGLE_SPEECH_PROFANITY_FILTER': true});
    }
    await ep.set(opts)
      .catch((err) => this.logger.info(err, 'TaskTranscribe:_initSpeech error setting fs vars'));
    ep.addCustomEventListener(TranscriptionEvents.Transcription, this._onTranscription.bind(this, ep));
    ep.addCustomEventListener(TranscriptionEvents.NoAudioDetected, this._onNoAudio.bind(this, ep));
    ep.addCustomEventListener(TranscriptionEvents.MaxDurationExceeded, this._onMaxDurationExceeded.bind(this, ep));
  }

  async _startTranscribing(ep) {
    await ep.startTranscription({
      interim: this.interim ? true : false,
      language: this.language
    });
  }

  _onTranscription(ep, evt) {
    this.logger.debug(evt, 'TaskTranscribe:_onTranscription');
    this.actionHook(this.action, 'POST', {
      Speech: evt
    });
    if (this.killed) {
      this.logger.debug('TaskTranscribe:_onTranscription exiting after receiving final transcription');
      this._clearTimer();
      this._completionResolver();
    }
  }

  _onNoAudio(ep) {
    this.logger.debug('TaskTranscribe:_onNoAudio restarting transcription');
    this._startTranscribing(ep);
  }

  _onMaxDurationExceeded(ep) {
    this.logger.debug('TaskTranscribe:_onMaxDurationExceeded restarting transcription');
    this._startTranscribing(ep);
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

module.exports = TaskTranscribe;
