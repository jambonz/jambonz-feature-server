const Task = require('./task');
const {TaskName, TaskPreconditions, TranscriptionEvents} = require('../utils/constants');

class TaskTranscribe extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.transcriptionHook = this.data.transcriptionHook;
    this.earlyMedia = this.data.earlyMedia === true || (parentTask && parentTask.earlyMedia);
    if (this.data.recognizer) {
      this.language = this.data.recognizer.language || 'en-US';
      this.vendor = this.data.recognizer.vendor;
      this.interim = this.data.recognizer.interim === true;
      this.dualChannel = this.data.recognizer.dualChannel === true;
    }
  }

  get name() { return TaskName.Transcribe; }

  async exec(cs, ep, parentTask) {
    super.exec(cs);
    this.ep = ep;
    try {
      await this._startTranscribing(ep);
      await this.awaitTaskDone();
    } catch (err) {
      this.logger.info(err, 'TaskTranscribe:exec - error');
    }
    ep.removeCustomEventListener(TranscriptionEvents.Transcription);
    ep.removeCustomEventListener(TranscriptionEvents.NoAudioDetected);
    ep.removeCustomEventListener(TranscriptionEvents.MaxDurationExceeded);
  }

  async kill(cs) {
    super.kill(cs);
    if (this.ep.connected) {
      this.ep.stopTranscription().catch((err) => this.logger.info(err, 'Error TaskTranscribe:kill'));

      // hangup after 1 sec if we don't get a final transcription
      this._timer = setTimeout(() => this.notifyTaskDone(), 1000);
    }
    else this.notifyTaskDone();
    await this.awaitTaskDone();
  }

  async _startTranscribing(ep) {
    const opts = {
      GOOGLE_SPEECH_USE_ENHANCED: true,
      GOOGLE_SPEECH_MODEL: 'phone_call'
    };
    if (this.hints) {
      Object.assign(opts, {'GOOGLE_SPEECH_HINTS': this.hints.join(',')});
    }
    if (this.profanityFilter) {
      Object.assign(opts, {'GOOGLE_SPEECH_PROFANITY_FILTER': true});
    }
    if (this.dualChannel) {
      Object.assign(opts, {'GOOGLE_SPEECH_SEPARATE_RECOGNITION_PER_CHANNEL': true});
    }
    await ep.set(opts)
      .catch((err) => this.logger.info(err, 'TaskTranscribe:_startTranscribing'));

    ep.addCustomEventListener(TranscriptionEvents.Transcription, this._onTranscription.bind(this, ep));
    ep.addCustomEventListener(TranscriptionEvents.NoAudioDetected, this._onNoAudio.bind(this, ep));
    ep.addCustomEventListener(TranscriptionEvents.MaxDurationExceeded, this._onMaxDurationExceeded.bind(this, ep));

    await this._transcribe(ep);
  }

  async _transcribe(ep) {
    await this.ep.startTranscription({
      interim: this.interim ? true : false,
      language: this.language || this.callSession.speechRecognizerLanguage,
      channels: this.dualChannel ? 2 : 1
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
