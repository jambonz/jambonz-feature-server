const Task = require('./task');
const {TaskName, TaskPreconditions, ListenEvents, ListenStatus} = require('../utils/constants.json');
const makeTask = require('./make_task');
const moment = require('moment');
const MAX_PLAY_AUDIO_QUEUE_SIZE = 10;
const DTMF_SPAN_NAME = 'dtmf';

class TaskListen extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    /**
     * @deprecated
     * use bidirectionalAudio.enabled
     */
    this.disableBidirectionalAudio = opts.disableBidirectionalAudio;
    this.preconditions = TaskPreconditions.Endpoint;

    [
      'action', 'auth', 'method', 'url', 'finishOnKey', 'maxLength', 'metadata', 'mixType', 'passDtmf', 'playBeep',
      'sampleRate', 'timeout', 'transcribe', 'wsAuth', 'disableBidirectionalAudio', 'channel'
    ].forEach((k) => this[k] = this.data[k]);

    this.mixType = this.mixType || 'mono';
    this.sampleRate = this.sampleRate || 8000;
    this.earlyMedia = this.data.earlyMedia === true;
    this.parentTask = parentTask;
    this.nested = parentTask instanceof Task;

    this.results = {};
    this.playAudioQueue = [];
    this.isPlayingAudioFromQueue = false;
    this.bidirectionalAudio = {
      enabled: this.disableBidirectionalAudio === true ? false : true,
      ...(this.data['bidirectionalAudio']),
    };

    // From drachtio-version 3.0.40, forkAudioStart will send empty bugname, metadata together with
    // bidirectionalAudio params that cause old version of freeswitch missunderstand between bugname and
    // bidirectionalAudio params
    this._bugname = 'audio_fork';

    if (this.transcribe) this.transcribeTask = makeTask(logger, {'transcribe': opts.transcribe}, this);
  }

  get name() { return TaskName.Listen; }

  set bugname(name) { this._bugname = name; }

  set ignoreCustomerData(val) { this._ignoreCustomerData = val; }

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
    if (this.transcribeTask) this.transcribeTask.kill(cs);
    this._removeListeners(ep);
  }

  async kill(cs) {
    super.kill(cs);
    this.logger.debug(`TaskListen:kill endpoint connected? ${this.ep && this.ep.connected}`);
    this._clearTimer();
    this.playAudioQueue = [];
    if (this.ep && this.ep.connected) {
      this.logger.debug('TaskListen:kill closing websocket');
      try {
        const args = this._bugname ? [this._bugname] : [];
        await this.ep.forkAudioStop(...args);
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

  async updateListen(status, silence = false) {
    if (!this.killed && this.ep && this.ep.connected) {
      const args = [
        ...(this._bugname ? [this._bugname] : []),
        ...(status === ListenStatus.Pause ? ([silence]) : []),
      ];
      this.logger.info(`TaskListen:updateListen status ${status}`);
      switch (status) {
        case ListenStatus.Pause:
          await this.ep.forkAudioPause(...args)
            .catch((err) => this.logger.info(err, 'TaskListen: error pausing audio'));
          break;
        case ListenStatus.Resume:
          await this.ep.forkAudioResume(...args)
            .catch((err) => this.logger.info(err, 'TaskListen: error resuming audio'));
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
    const ci = this.nested ? this.parentTask.sd.callInfo : cs.callInfo.toJSON();
    if (this._ignoreCustomerData) {
      delete ci.customerData;
    }
    const metadata = Object.assign(
      {sampleRate: this.sampleRate, mixType: this.mixType},
      ci,
      this.metadata);
    if (this.hook.auth) {
      await this.ep.set({
        'MOD_AUDIO_BASIC_AUTH_USERNAME': this.hook.auth.username,
        'MOD_AUDIO_BASIC_AUTH_PASSWORD': this.hook.auth.password
      });
    }
    await ep.forkAudioStart({
      wsUrl: this.hook.url,
      mixType: this.mixType,
      sampling: this.sampleRate,
      ...(this._bugname && {bugname: this._bugname}),
      metadata,
      bidirectionalAudio: this.bidirectionalAudio || {}
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
    if (this.bidirectionalAudio.enabled) {
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
    const {dtmf, duration} = evt;
    this.logger.debug({evt}, `TaskListen:_onDtmf received dtmf ${dtmf}`);
    if (this.passDtmf && this.ep?.connected) {
      const obj = {event: 'dtmf', dtmf, duration};
      const args = this._bugname ? [this._bugname, obj] : [obj];
      this.ep.forkAudioSendText(...args)
        .catch((err) => this.logger.info({err}, 'TaskListen:_onDtmf error sending dtmf'));
    }

    /* add a child span for the dtmf event */
    const msDuration = Math.floor((duration / 8000) * 1000);
    const {span} = this.startChildSpan(`${DTMF_SPAN_NAME}:${dtmf}`);
    span.setAttributes({
      channel: 1,
      dtmf,
      duration: `${msDuration}ms`
    });
    span.end();

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
    this.logger.info('TaskListen:_onConnect');
  }
  _onConnectFailure(ep, evt) {
    this.logger.info(evt, 'TaskListen:_onConnectFailure');
    this.notifyTaskDone();
  }

  async _playAudio(ep, evt, logger) {
    try {
      const results = await ep.play(evt.file);
      logger.debug(`Finished playing file, result: ${JSON.stringify(results)}`);
      const obj = {
        type: 'playDone',
        data: {
          id: evt.id,
          ...results
        }
      };
      const args = this._bugname ? [this._bugname, obj] : [obj];
      ep.forkAudioSendText(...args);
    } catch (err) {
      logger.error({err}, 'Error playing file');
    }
  }

  async _onPlayAudio(ep, evt) {
    this.logger.info(`received play_audio event: ${JSON.stringify(evt)}`);
    if (!evt.queuePlay) {
      this.playAudioQueue = [];
      this._playAudio(ep, evt, this.logger);
      this.isPlayingAudioFromQueue = false;
      return;
    }

    if (this.playAudioQueue.length <= MAX_PLAY_AUDIO_QUEUE_SIZE) {
      this.playAudioQueue.push(evt);
    }

    if (this.isPlayingAudioFromQueue) return;

    this.isPlayingAudioFromQueue = true;
    while (this.playAudioQueue.length > 0) {
      await this._playAudio(ep, this.playAudioQueue.shift(), this.logger);
    }
    this.isPlayingAudioFromQueue = false;
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
