const Task = require('./task');
const {TaskName, TaskPreconditions, ListenEvents} = require('../utils/constants');
const makeTask = require('./make_task');
const assert = require('assert');

class TaskListen extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    [
      'url', 'finishOnKey', 'maxLength', 'metadata', 'mixType', 'passDtmf', 'playBeep',
      'sampleRate', 'timeout', 'transcribe'
    ].forEach((k) => this[k] = this.data[k]);

    this.mixType = this.mixType || 'mono';
    this.sampleRate = this.sampleRate || 8000;
    this.earlyMedia = this.data.earlyMedia === true;

    if (this.transcribe) {
      this.transcribeTask = makeTask(logger, {'transcribe': opts.transcribe});
    }

    this._dtmfHandler = this._onDtmf.bind(this);

    this._completionPromise = new Promise((resolve) => this._completionResolver = resolve);
  }

  get name() { return TaskName.Listen; }

  async exec(cs, ep) {
    this.ep = ep;
    try {
      if (this.playBeep) await this._playBeep(ep);
      if (this.transcribeTask) {
        this.logger.debug('TaskListen:exec - starting nested transcribe task');
        this.transcribeTask.exec(cs, ep, this);  // kicked off, _not_ waiting for it to complete
      }
      await this._startListening(ep);
      await this._completionPromise;
    } catch (err) {
      this.logger.info(err, `TaskListen:exec - error ${this.url}`);
    }
    if (this.transcribeTask) this.transcribeTask.kill();
    this._removeListeners(ep);
    this.listenComplete = true;
    this.emit('listenDone');
  }

  async kill() {
    super.kill();
    this._clearTimer();
    if (this.ep.connected && !this.listenComplete) {
      this.listenComplete = true;
      if (this.transcribeTask) {
        await this.transcribeTask.kill();
        this.transcribeTask = null;
      }
      await this.ep.forkAudioStop()
        .catch((err) => this.logger.info(err, 'TaskListen:kill'));
    }
    this._completionResolver();
  }

  async _playBeep(ep) {
    await ep.play('tone_stream://L=1;%(500, 0, 1500)')
      .catch((err) => this.logger.info(err, 'TaskListen:_playBeep Error playing beep'));
  }

  async _startListening(ep) {
    this._initListeners(ep);
    await ep.forkAudioStart({
      wsUrl: this.url,
      mixType: this.mixType,
      sampling: this.sampleRate,
      metadata: this.metadata
    });
    if (this.timeout) {
      this._timer = setTimeout(() => {
        this.logger.debug(`TaskListen:_startListening terminating task due to timeout of ${this.timeout} reached`);
        this.kill();
      }, this.timeout * 1000);
    }
  }

  _initListeners(ep) {
    ep.addCustomEventListener(ListenEvents.Connect, this._onConnect.bind(this, ep));
    ep.addCustomEventListener(ListenEvents.ConnectFailure, this._onConnectFailure.bind(this, ep));
    ep.addCustomEventListener(ListenEvents.Error, this._onError.bind(this, ep));
    if (this.finishOnKey || this.passDtmf) {
      ep.on('dtmf', this._dtmfHandler);
    }
  }

  _removeListeners(ep) {
    ep.removeCustomEventListener(ListenEvents.Connect);
    ep.removeCustomEventListener(ListenEvents.ConnectFailure);
    ep.removeCustomEventListener(ListenEvents.Error);
    if (this.finishOnKey || this.passDtmf) {
      ep.removeListener('dtmf', this._dtmfHandler);
    }
  }

  _onDtmf(evt) {
    if (evt.dtmf === this.finishOnKey) {
      this.logger.info(`TaskListen:_onDtmf terminating task due to dtmf ${evt.dtmf}`);
      this.kill();
    }
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
  _onConnect(ep) {
    this.logger.debug('TaskListen:_onConnect');
  }
  _onConnectFailure(ep, evt) {
    this.logger.info(evt, 'TaskListen:_onConnectFailure');
    this._completionResolver();
  }
  _onError(ep, evt) {
    this.logger.info(evt, 'TaskListen:_onError');
    this._completionResolver();
  }

}

module.exports = TaskListen;
