const Task = require('./task');
const {TaskName, TaskPreconditions, ListenEvents, ListenStatus} = require('../utils/constants');
const makeTask = require('./make_task');
const moment = require('moment');

class TaskListen extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    [
      'action', 'auth', 'method', 'url', 'finishOnKey', 'maxLength', 'metadata', 'mixType', 'passDtmf', 'playBeep',
      'sampleRate', 'timeout', 'transcribe', 'wsAuth', 'disableBidirectionalAudio'
    ].forEach((k) => this[k] = this.data[k]);

    this.mixType = this.mixType || 'mono';
    this.sampleRate = this.sampleRate || 8000;
    this.earlyMedia = this.data.earlyMedia === true;
    this.parentTask = parentTask;
    this.nested = parentTask instanceof Task;

    this.results = {};

    if (this.transcribe) this.transcribeTask = makeTask(logger, {'transcribe': opts.transcribe}, this);
  }

  get name() { return TaskName.Listen; }

  async exec(cs, {ep}) {
    await super.exec(cs);
    this.ep = ep;
    this._dtmfHandler = this._onDtmf.bind(this, ep);

    try {
      this.hook = this.normalizeUrl(this.url, 'GET', this.wsAuth);
      this.logger.debug({hook: this.hook}, 'prepared ws url');
      if (this.playBeep) await this._playBeep(ep);
      if (this.transcribeTask) {
        this.logger.debug('TaskListen:exec - starting nested transcribe task');
        const {span, ctx} = this.startChildSpan(`nested:${this.transcribeTask.summary}`);
        this.transcribeTask.span = span;
        this.transcribeTask.ctx = ctx;
        this.transcribeTask.exec(cs, {ep})
          .then((result) => span.end())
          .catch((err) => span.end());
      }
      await this._startListening(cs, ep);
      await this.awaitTaskDone();
      await this.performAction(this.results, !this.nested);
    } catch (err) {
      this.logger.info(err, `TaskListen:exec - error ${this.url}`);
    }
    if (this.transcribeTask) this.transcribeTask.kill();
    this._removeListeners(ep);
  }

  async kill(cs) {
    super.kill(cs);
    this.logger.debug(`TaskListen:kill endpoint connected? ${this.ep && this.ep.connected}`);
    this._clearTimer();
    if (this.ep && this.ep.connected) {
      this.logger.debug('TaskListen:kill closing websocket');
      try {
        await this.ep.forkAudioStop();
        this.logger.debug('TaskListen:kill successfully closed websocket');
      } catch (err) {
        this.logger.info(err, 'TaskListen:kill');
      }
    }
    if (this.recordStartTime) {
      const duration = moment().diff(this.recordStartTime, 'seconds');
      this.results.dialCallDuration = duration;
    }
    if (this.transcribeTask) {
      await this.transcribeTask.kill(cs);
      this.transcribeTask = null;
    }
    this.ep && this._removeListeners(this.ep);
    this.notifyTaskDone();
  }

  async updateListen(status) {
    if (!this.killed && this.ep && this.ep.connected) {
      this.logger.info(`TaskListen:updateListen status ${status}`);
      switch (status) {
        case ListenStatus.Pause:
          await this.ep.forkAudioPause().catch((err) => this.logger.info(err, 'TaskListen: error pausing audio'));
          break;
        case ListenStatus.Resume:
          await this.ep.forkAudioResume().catch((err) => this.logger.info(err, 'TaskListen: error resuming audio'));
          break;
      }
    }
  }

  async _playBeep(ep) {
    await ep.play('tone_stream://L=1;%(500, 0, 1500)')
      .catch((err) => this.logger.info(err, 'TaskListen:_playBeep Error playing beep'));
  }

  async _startListening(cs, ep) {
    this._initListeners(ep);
    const metadata = Object.assign(
      {sampleRate: this.sampleRate, mixType: this.mixType},
      this.nested ? this.parentTask.sd.callInfo : cs.callInfo.toJSON(),
      this.metadata);
    if (this.hook.auth) {
      this.logger.debug({username: this.hook.auth.username, password: this.hook.auth.password},
        'TaskListen:_startListening basic auth');
      await this.ep.set({
        'MOD_AUDIO_BASIC_AUTH_USERNAME': this.hook.auth.username,
        'MOD_AUDIO_BASIC_AUTH_PASSWORD': this.hook.auth.password
      });
    }
    await ep.forkAudioStart({
      wsUrl: this.hook.url,
      mixType: this.mixType,
      sampling: this.sampleRate,
      metadata
    });
    this.recordStartTime = moment();
    if (this.maxLength) {
      this._timer = setTimeout(() => {
        this.logger.debug(`TaskListen terminating task due to timeout of ${this.timeout}s reached`);
        this.kill(cs);
      }, this.maxLength * 1000);
    }
  }

  _initListeners(ep) {
    ep.addCustomEventListener(ListenEvents.Connect, this._onConnect.bind(this, ep));
    ep.addCustomEventListener(ListenEvents.ConnectFailure, this._onConnectFailure.bind(this, ep));
    ep.addCustomEventListener(ListenEvents.Error, this._onError.bind(this, ep));
    if (this.finishOnKey || this.passDtmf) {
      ep.on('dtmf', this._dtmfHandler);
    }

    /* support bi-directional audio */
    if (!this.disableBiDirectionalAudio) {
      ep.addCustomEventListener(ListenEvents.PlayAudio, this._onPlayAudio.bind(this, ep));
    }
    ep.addCustomEventListener(ListenEvents.KillAudio, this._onKillAudio.bind(this, ep));
    ep.addCustomEventListener(ListenEvents.Disconnect, this._onDisconnect.bind(this, ep));
  }

  _removeListeners(ep) {
    ep.removeCustomEventListener(ListenEvents.Connect);
    ep.removeCustomEventListener(ListenEvents.ConnectFailure);
    ep.removeCustomEventListener(ListenEvents.Error);
    if (this.finishOnKey || this.passDtmf) {
      ep.removeListener('dtmf', this._dtmfHandler);
    }
    ep.removeCustomEventListener(ListenEvents.PlayAudio);
    ep.removeCustomEventListener(ListenEvents.KillAudio);
    ep.removeCustomEventListener(ListenEvents.Disconnect);

  }

  _onDtmf(ep, evt) {
    this.logger.debug({evt}, `TaskListen:_onDtmf received dtmf ${evt.dtmf}`);
    if (this.passDtmf && this.ep?.connected) {
      const obj = {event: 'dtmf', dtmf: evt.dtmf, duration: evt.duration};
      this.ep.forkAudioSendText(obj)
        .catch((err) => this.logger.info({err}, 'TaskListen:_onDtmf error sending dtmf'));
    }
    if (evt.dtmf === this.finishOnKey) {
      this.logger.info(`TaskListen:_onDtmf terminating task due to dtmf ${evt.dtmf}`);
      this.results.digits = evt.dtmf;
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
    this.notifyTaskDone();
  }

  async _onPlayAudio(ep, evt) {
    this.logger.info(`received play_audio event: ${JSON.stringify(evt)}`);
    try {
      const results = await ep.play(evt.file);
      this.logger.debug(`Finished playing file, result: ${JSON.stringify(results)}`);
      ep.forkAudioSendText({type: 'playDone', data: Object.assign({id: evt.id}, results)});
    }
    catch (err) {
      this.logger.error({err}, 'Error playing file');
    }
  }

  _onKillAudio(ep) {
    this.logger.info('received kill_audio event');
    ep.api('uuid_break', ep.uuid);
  }

  _onDisconnect(ep, cs) {
    this.logger.debug('_onDisconnect: TaskListen terminating task');
    this.kill(cs);
  }

  _onError(ep, evt) {
    this.logger.info(evt, 'TaskListen:_onError');
    this.notifyTaskDone();
  }

  /**
   * play or say something during the call
   * @param {*} tasks - array of play/say tasks to execute
   */
  async whisper(tasks, callSid) {
    try {
      const cs = this.callSession;
      this.logger.debug('Listen:whisper tasks starting');
      while (tasks.length && !cs.callGone) {
        const task = tasks.shift();
        await task.exec(cs, {ep: this.ep});
      }
      this.logger.debug('Listen:whisper tasks complete');
    } catch (err) {
      this.logger.error(err, 'Listen:whisper error');
    }
  }

}

module.exports = TaskListen;
