const Emitter = require('events');
const fs = require('fs');
const {CallDirection, TaskPreconditions, CallStatus, TaskName} = require('../utils/constants');
const moment = require('moment');
const assert = require('assert');
const sessionTracker = require('./session-tracker');
const makeTask = require('../tasks/make_task');
const normalizeJambones = require('../utils/normalize-jambones');
const listTaskNames = require('../utils/summarize-tasks');
const BADPRECONDITIONS = 'preconditions not met';
const CALLER_CANCELLED_ERR_MSG = 'Response not sent due to unknown transaction';

/**
 * @classdesc Represents the execution context for a call.
 * It holds the resources, such as the sip dialog and media server endpoint
 * that are needed by Tasks that are operating on the call.<br/><br/>
 * CallSession is a superclass object that is extended by specific types
 * of sessions, such as InboundCallSession, RestCallSession and others.
 */
class CallSession extends Emitter {
  /**
   *
   * @param {object} opts
   * @param {logger} opts.logger - a pino logger
   * @param {object} opts.application - the application to execute
   * @param {Srf} opts.srf - the Srf instance
   * @param {array} opts.tasks - tasks we are to execute
   * @param {callInfo} opts.callInfo - information about the call
   */
  constructor({logger, application, srf, tasks, callInfo}) {
    super();
    this.logger = logger;
    this.application = application;
    this.srf = srf;
    this.callInfo = callInfo;
    this.tasks = tasks;
    this.taskIdx = 0;
    this.stackIdx = 0;
    this.callGone = false;

    this.tmpFiles = new Set();

    if (!this.isSmsCallSession) {
      this.updateCallStatus = srf.locals.dbHelpers.updateCallStatus;
      this.serviceUrl = srf.locals.serviceUrl;
    }

    if (!this.isConfirmCallSession && !this.isSmsCallSession) {
      sessionTracker.add(this.callSid, this);
    }
  }

  /**
   * callSid for the call being handled by the session
   */
  get callSid() {
    return this.callInfo.callSid;
  }

  /**
   * direction of the call: inbound or outbound
   */
  get direction() {
    return this.callInfo.direction;
  }

  /**
   * SIP call-id for the call
   */
  get callId() {
    return this.callInfo.callId;
  }

  /**
   * http endpoint to send call status updates to
   */
  get call_status_hook() {
    return this.application.call_status_hook;
  }

  /**
   * can be used for all http requests within this session
   */
  get requestor() {
    assert(this.application.requestor);
    return this.application.requestor;
  }

  /**
   * can be used for all http call status notifications within this session
   */
  get notifier() {
    assert(this.application.notifier);
    return this.application.notifier;
  }

  /**
   * default vendor to use for speech synthesis if not provided in the app
   */
  get speechSynthesisVendor() {
    return this.application.speech_synthesis_vendor;
  }
  /**
   * default voice to use for speech synthesis if not provided in the app
   */
  get speechSynthesisVoice() {
    return this.application.speech_synthesis_voice;
  }
  /**
   * default language to use for speech synthesis if not provided in the app
   */
  get speechSynthesisLanguage() {
    return this.application.speech_synthesis_language;
  }

  /**
   * default vendor to use for speech recognition if not provided in the app
   */
  get speechRecognizerVendor() {
    return this.application.speech_recognizer_vendor;
  }
  /**
 * default language to use for speech recognition if not provided in the app
 */
  get speechRecognizerLanguage() {
    return this.application.speech_recognizer_language;
  }

  /**
   * indicates whether the call currently in progress
   */
  get hasStableDialog() {
    return this.dlg && this.dlg.connected;
  }

  /**
   * indicates whether call is currently in a ringing state (ie not yet answered)
   */
  get isOutboundCallRinging() {
    return this.direction === CallDirection.Outbound && this.req && !this.dlg;
  }

  /**
   * returns true if the call is an inbound call and a final sip response has been sent
   */
  get isInboundCallAnswered() {
    return this.direction === CallDirection.Inbound && this.res.finalResponseSent;
  }

  /**
   * returns the account sid
   */
  get accountSid() {
    return this.callInfo.accountSid;
  }

  /**
   * returns true if this session was transferred from another server
   */
  get isTransferredCall() {
    return this.application.transferredCall === true;
  }

  /**
   * returns true if this session is a ConfirmCallSession
   */
  get isConfirmCallSession() {
    return this.constructor.name === 'ConfirmCallSession';
  }

  /**
   * returns true if this session is a SmsCallSession
   */
  get isSmsCallSession() {
    return this.constructor.name === 'SmsCallSession';
  }

  /**
   * execute the tasks in the CallSession.  The tasks are executed in sequence until
   * they complete, or the caller hangs up.
   * @async
   */
  async exec() {
    this.logger.info({tasks: listTaskNames(this.tasks)}, `CallSession:exec starting ${this.tasks.length} tasks`);
    while (this.tasks.length && !this.callGone) {
      const taskNum = ++this.taskIdx;
      const stackNum = this.stackIdx;
      const task = this.tasks.shift();
      this.logger.info(`CallSession:exec starting task #${stackNum}:${taskNum}: ${task.name}`);
      try {
        const resources = await this._evaluatePreconditions(task);
        this.currentTask = task;
        await task.exec(this, resources);
        this.currentTask = null;
        this.logger.info(`CallSession:exec completed task #${stackNum}:${taskNum}: ${task.name}`);
      } catch (err) {
        this.currentTask = null;
        if (err.message.includes(BADPRECONDITIONS)) {
          this.logger.info(`CallSession:exec task #${stackNum}:${taskNum}: ${task.name}: ${err.message}`);
        }
        else {
          this.logger.error(err, `Error executing task  #${stackNum}:${taskNum}: ${task.name}`);
          break;
        }
      }
    }

    // all done - cleanup
    this.logger.info('CallSession:exec all tasks complete');
    this._onTasksDone();
    this._clearResources();

    if (!this.isConfirmCallSession && !this.isSmsCallSession) sessionTracker.remove(this.callSid);
  }

  trackTmpFile(path) {
    // TODO: don't add if its already in the list (should we make it a set?)
    this.logger.debug(`adding tmp file to track ${path}`);
    this.tmpFiles.add(path);
  }

  normalizeUrl(url, method, auth) {
    const hook = {
      url,
      method
    };
    if (auth && auth.username && auth.password) {
      hook.auth = {
        username: auth.username,
        password: auth.password
      };
    }
    if (typeof url === 'string' && url.startsWith('/')) {
      const baseUrl = this.requestor.baseUrl;
      hook.url = `${baseUrl}${url}`;
      if (this.requestor.username && this.requestor.password) {
        hook.auth = {
          username: this.requestor.username,
          password: this.requestor.password
        };
      }
    }
    return hook;
  }
  /**
   * This is called when all tasks have completed.  It is not implemented in the superclass
   * but provided as a convenience for subclasses that need to do cleanup at the end of
   * the call session.
   */
  _onTasksDone() {
    // meant to be implemented by subclass if needed
  }

  /**
   * this is called to clean up when the call is released from one side or another
   */
  _callReleased() {
    this.logger.debug('CallSession:_callReleased - caller hung up');
    this.callGone = true;
    if (this.currentTask) {
      this.currentTask.kill(this);
      this.currentTask = null;
    }
  }

  /**
   * perform live call control - update call status
   * @param {obj} opts
   * @param {string} opts.call_status - 'complete' or 'no-answer'
   */
  _lccCallStatus(opts) {
    if (opts.call_status === CallStatus.Completed && this.dlg) {
      this.logger.info('CallSession:updateCall hanging up call due to request from api');
      this._callerHungup();
    }
    else if (opts.call_status === CallStatus.NoAnswer) {
      if (this.direction === CallDirection.Inbound) {
        if (this.res && !this.res.finalResponseSent) {
          this.res.send(503);
          this._callReleased();
        }
      }
      else {
        if (this.req && !this.dlg) {
          this.req.cancel();
          this._callReleased();
        }
      }
    }
  }

  /**
   * perform live call control -- set a new call_hook
   * @param {object} opts
   * @param {object} opts.call_hook - new call_hook to transfer to
   * @param {object} [opts.call_hook] - new call_status_hook
   */
  async _lccCallHook(opts) {
    const tasks = await this.requestor.request(opts.call_hook, this.callInfo);
    if (tasks && tasks.length > 0) {
      this.logger.info({tasks: listTaskNames(tasks)}, 'CallSession:updateCall new task list');
      this.replaceApplication(normalizeJambones(this.logger, tasks).map((tdata) => makeTask(this.logger, tdata)));
    }
  }

  /**
   * perform live call control -- change listen status
   * @param {object} opts
   * @param {string} opts.listen_status - 'pause' or 'resume'
  */
  async _lccListenStatus(opts) {
    const task = this.currentTask;
    if (!task || ![TaskName.Dial, TaskName.Listen].includes(task.name)) {
      return this.logger.info(`CallSession:updateCall - invalid listen_status in task ${task.name}`);
    }
    const listenTask = task.name === TaskName.Listen ? task : task.listenTask;
    if (!listenTask) {
      return this.logger.info('CallSession:updateCall - invalid listen_status: Dial does not have a listen');
    }
    listenTask.updateListen(opts.listen_status);
  }

  async _lccMuteStatus(callSid, mute) {
    // this whole thing requires us to be in a Dial verb
    const task = this.currentTask;
    if (!task || TaskName.Dial !== task.name) {
      return this.logger.info('CallSession:_lccMute - invalid command as dial is not active');
    }
    // now do the whisper
    task.mute(callSid, mute).catch((err) => this.logger.error(err, 'CallSession:_lccMute'));
  }

  /**
   * perform live call control -- whisper to one party or the other on a call
   * @param {array} opts - array of play or say tasks
   */
  async _lccWhisper(opts, callSid) {
    const {whisper} = opts;
    let tasks;

    // this whole thing requires us to be in a Dial verb
    const task = this.currentTask;
    if (!task || ![TaskName.Dial, TaskName.Listen].includes(task.name)) {
      return this.logger.info('CallSession:_lccWhisper - invalid command since we are not in a dial or listen');
    }

    // allow user to provide a url object, a url string, an array of tasks, or a single task
    if (typeof whisper === 'string' || (typeof whisper === 'object' && whisper.url)) {
      // retrieve a url
      const json = await this.requestor(opts.call_hook, this.callInfo);
      tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
    }
    else if (Array.isArray(whisper)) {
      // an inline array of tasks
      tasks = normalizeJambones(this.logger, whisper).map((tdata) => makeTask(this.logger, tdata));
    }
    else if (typeof whisper === 'object') {
      // a single task
      tasks = normalizeJambones(this.logger, [whisper]).map((tdata) => makeTask(this.logger, tdata));
    }
    else {
      this.logger.info({opts}, 'CallSession:_lccWhisper invalid options were provided');
      return;
    }
    this.logger.debug(`CallSession:_lccWhisper got ${tasks.length} tasks`);

    // only say or play allowed
    if (tasks.find((t) => ![TaskName.Say, TaskName.Play].includes(t.name))) {
      this.logger.info('CallSession:_lccWhisper invalid options where provided');
      return;
    }

    //multiple loops not allowed
    tasks.forEach((t) => t.loop = 1);

    // now do the whisper
    this.logger.debug(`CallSession:_lccWhisper executing ${tasks.length} tasks`);
    task.whisper(tasks, callSid).catch((err) => this.logger.error(err, 'CallSession:_lccWhisper'));
  }

  /**
   * perform live call control -- mute or unmute an endpoint
   * @param {array} opts - array of play or say tasks
   */
  async _lccMute(callSid, mute) {

    // this whole thing requires us to be in a Dial verb
    const task = this.currentTask;
    if (!task || TaskName.Dial !== task.name) {
      return this.logger.info('CallSession:_lccMute - not possible since we are not in a dial');
    }

    task.mute(callSid, mute).catch((err) => this.logger.error(err, 'CallSession:_lccMute'));
  }

  /**
   * perform live call control
   * @param {object} opts - update instructions
   * @param {string} callSid - identifies call toupdate
   */
  async updateCall(opts, callSid) {
    this.logger.debug(opts, 'CallSession:updateCall');

    if (opts.call_status) {
      return this._lccCallStatus(opts);
    }
    if (opts.call_hook) {
      return await this._lccCallHook(opts);
    }
    if (opts.listen_status) {
      await this._lccListenStatus(opts);
    }
    else if (opts.mute_status) {
      await this._lccMuteStatus(callSid, opts.mute_status === 'mute');
    }

    // whisper may be the only thing we are asked to do, or it may that
    // we are doing a whisper after having muted, paused reccording etc..
    if (opts.whisper) {
      return this._lccWhisper(opts, callSid);
    }
  }

  /**
   * Replace the currently-executing application with a new application
   * NB: any tasks in the current stack that have not been executed are flushed
   */
  replaceApplication(tasks) {
    if (this.callGone) {
      this.logger.debug('CallSession:replaceApplication - ignoring because call is gone');
      return;
    }
    this.tasks = tasks;
    this.taskIdx = 0;
    this.stackIdx++;
    this.logger.info({tasks: listTaskNames(tasks)},
      `CallSession:replaceApplication reset with ${tasks.length} new tasks, stack depth is ${this.stackIdx}`);
    if (this.currentTask) {
      this.currentTask.kill();
      this.currentTask = null;
    }
  }

  kill() {
    if (this.isConfirmCallSession) this.logger.debug('CallSession:kill (ConfirmSession)');
    else this.logger.info('CallSession:kill');
    if (this.currentTask) {
      this.currentTask.kill();
      this.currentTask = null;
    }
    this.tasks = [];
    this.taskIdx = 0;
  }

  _evaluatePreconditions(task) {
    switch (task.preconditions) {
      case TaskPreconditions.None:
        return;
      case TaskPreconditions.Endpoint:
        return this._evalEndpointPrecondition(task);
      case TaskPreconditions.StableCall:
        return this._evalStableCallPrecondition(task);
      case TaskPreconditions.UnansweredCall:
        return this._evalUnansweredCallPrecondition(task);
      default:
        assert(0, `invalid/unknown or missing precondition type ${task.preconditions} for task ${task.name}`);
    }
  }

  /**
   * Configure call state so as to make a media endpoint available
   * @param {Task} task - task to be executed
   */
  async _evalEndpointPrecondition(task) {
    this.logger.debug('CallSession:_evalEndpointPrecondition');
    if (this.callGone) new Error(`${BADPRECONDITIONS}: call gone`);

    if (this.ep) {
      if (task.earlyMedia === true || this.dlg) return this.ep;

      // we are going from an early media connection to answer
      await this.propagateAnswer();
      return this.ep;
    }

    // need to allocate an endpoint
    try {
      if (!this.ms) this.ms = this.getMS();
      const ep = await this.ms.createEndpoint({remoteSdp: this.req.body});
      ep.cs = this;
      this.ep = ep;
      await ep.set('hangup_after_bridge', false);

      this.logger.debug('allocated endpoint');

      if (this.direction === CallDirection.Inbound) {
        if (task.earlyMedia && !this.req.finalResponseSent) {
          this.res.send(183, {body: ep.local.sdp});
          return ep;
        }
        this.logger.debug('propogating answer');
        await this.propagateAnswer();
      }
      else {
        // outbound call TODO
      }

      return ep;
    } catch (err) {
      if (err === CALLER_CANCELLED_ERR_MSG) {
        this.logger.error(err, 'caller canceled quickly before we could respond, ending call');
        this._notifyCallStatusChange({callStatus: CallStatus.NoAnswer, sipStatus: 487});
        this._callReleased();
      }
      else {
        this.logger.error(err, `Error attempting to allocate endpoint for for task ${task.name}`);
        throw new Error(`${BADPRECONDITIONS}: unable to allocate endpoint`);
      }
    }
  }

  /**
   * Configure call state so as to make a sip dialog available
   * @param {Task} task - task to be executed
   */
  _evalStableCallPrecondition(task) {
    if (this.callGone) throw new Error(`${BADPRECONDITIONS}: call gone`);
    if (!this.dlg) throw new Error(`${BADPRECONDITIONS}: call was not answered`);
    return this.dlg;
  }

  /**
   * Throws an error if call has already been answered
   * @param {Task} task - task to be executed
   */
  _evalUnansweredCallPrecondition(task, callSid) {
    if (!this.req) throw new Error('invalid precondition unanswered_call for outbound call');
    if (this.callGone) new Error(`${BADPRECONDITIONS}: call gone`);
    if (this.res.finalResponseSent) {
      throw new Error(`${BADPRECONDITIONS}: final sip status already sent`);
    }
    return {req: this.req, res: this.res};
  }

  /**
   * Discard the current endpoint and allocate a new one, connecting the dialog to it.
   * This is used, for instance, from the Conference verb when a caller has been
   * kicked out of conference when a moderator leaves -- the endpoint is destroyed
   * as well, but the app may want to continue on with other actions
   */
  async replaceEndpoint() {
    if (!this.dlg) {
      this.logger.error('CallSession:replaceEndpoint cannot be called without stable dlg');
      return;
    }
    this.ep = await this.ms.createEndpoint({remoteSdp: this.dlg.remote.sdp});
    await this.ep.set('hangup_after_bridge', false);

    await this.dlg.modify(this.ep.local.sdp);
    this.logger.debug('CallSession:replaceEndpoint completed');
    return this.ep;
  }

  /**
   * Hang up the call and free the media endpoint
   */
  async _clearResources() {
    for (const resource of [this.dlg, this.ep]) {
      try {
        if (resource && resource.connected) await resource.destroy();
      } catch (err) {
        this.logger.error(err, 'CallSession:_clearResources error');
      }
    }

    // remove any temporary tts files that were created (audio is still cached in redis)
    for (const path of this.tmpFiles) {
      fs.unlink(path, (err) => {
        if (err) {
          return this.logger.error(err, `CallSession:_clearResources Error deleting tmp file ${path}`);
        }
        this.logger.debug(`CallSession:_clearResources successfully deleted ${path}`);
      });
    }
    this.tmpFiles.clear();
  }

  /**
   * called when the caller has hung up.  Provided for subclasses to override
   * in order to apply logic at this point if needed.
   */
  _callerHungup() {
    assert(false, 'subclass responsibility to override this method');
  }

  /**
   * get a media server to use for this call
   */
  getMS() {
    if (!this.ms) {
      this.ms = this.srf.locals.getFreeswitch();
      if (!this.ms) {
        this._mediaServerFailure = true;
        throw new Error('no available freeswitch');
      }
    }
    return this.ms;
  }

  /**
   * Answer the call, if it has not already been answered.
   *
   * NB: This should be the one and only place we generate 200 OK to incoming INVITEs
   */
  async propagateAnswer() {
    if (!this.dlg) {
      assert(this.ep);
      this.dlg = await this.srf.createUAS(this.req, this.res, {localSdp: this.ep.local.sdp});
      this.logger.debug('answered call');
      this.dlg.on('destroy', this._callerHungup.bind(this));
      this.wrapDialog(this.dlg);
      this.dlg.callSid = this.callSid;
      this.emit('callStatusChange', {sipStatus: 200, callStatus: CallStatus.InProgress});

      this.dlg.on('modify', this._onReinvite.bind(this));

      this.logger.debug(`CallSession:propagateAnswer - answered callSid ${this.callSid}`);
    }
  }

  async _onReinvite(req, res) {
    try {
      const newSdp = await this.ep.modify(req.body);
      res.send(200, {body: newSdp});
      this.logger.info({offer: req.body, answer: newSdp}, 'handling reINVITE');
    } catch (err) {
      this.logger.error(err, 'Error handling reinvite');
    }
  }

  /**
   * create and endpoint if we don't have one; otherwise simply return
   * the current media server and endpoint that are associated with this call
   */
  async createOrRetrieveEpAndMs() {
    if (this.ms && this.ep) return {ms: this.ms, ep: this.ep};

    // get a media server
    if (!this.ms) {
      const ms = this.srf.locals.getFreeswitch();
      if (!ms) throw new Error('no available freeswitch');
      this.ms = ms;
    }
    if (!this.ep) {
      this.ep = await this.ms.createEndpoint({remoteSdp: this.req.body});
      await this.ep.set('hangup_after_bridge', false);
    }
    return {ms: this.ms, ep: this.ep};
  }

  /**
   * A conference that the current task is waiting on has just started
   * @param {*} opts
   */
  notifyConferenceEvent(opts) {
    if (this.currentTask && typeof this.currentTask.notifyStartConference === 'function') {
      this.currentTask.notifyStartConference(this, opts);
    }
  }

  /**
   * Notify a session in an Enqueue task of an event
   * @param {*} opts
   */
  notifyEnqueueEvent(opts) {
    if (this.currentTask && typeof this.currentTask.notifyQueueEvent === 'function') {
      this.currentTask.notifyQueueEvent(this, opts);
    }
  }

  /**
   * Notify a session in a Dequeue task of an event
   * @param {*} opts
   */
  notifyDequeueEvent(opts) {
    if (this.currentTask && typeof this.currentTask.notifyQueueEvent === 'function') {
      this.currentTask.notifyQueueEvent(this, opts);
    }
  }

  /**
   * Transfer the call to another feature server
   * @param {uri} sip uri to refer the call to
   */
  async referCall(referTo) {
    assert (this.hasStableDialog);

    const res = await this.dlg.request({
      method: 'REFER',
      headers: {
        'Refer-To': referTo,
        'Referred-By': `sip:${this.srf.locals.localSipAddress}`,
        'X-Retain-Call-Sid': this.callSid
      }
    });
    if ([200, 202].includes(res.status)) {
      this.tasks = [];
      this.taskIdx = 0;
      this.callMoved = true;
      return true;
    }
    return false;
  }

  getRemainingTaskData() {
    const tasks = [...this.tasks];
    tasks.unshift(this.currentTask);
    const remainingTasks = [];
    for (const task of tasks) {
      const o = {};
      o[task.name] = task.toJSON();
      remainingTasks.push(o);
    }
    return remainingTasks;
  }

  /**
   * Call this whenever we answer the A leg, creating a dialog
   * It wraps the 'destroy' method such that if we hang up the A leg
   * (e.g. via 'hangup' verb) we emit a callStatusChange event
   * @param {SipDialog} dlg
   */
  wrapDialog(dlg) {
    dlg.connectTime = moment();
    const origDestroy = dlg.destroy.bind(dlg);
    dlg.destroy = () => {
      if (dlg.connected) {
        dlg.connected = false;
        dlg.destroy = origDestroy;
        const duration = moment().diff(this.dlg.connectTime, 'seconds');
        this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
        this.logger.debug('CallSession: call terminated by jambones');
        origDestroy();
      }
    };
  }

  /**
   * Called any time call status changes.  This method both invokes the
   * call_status_hook callback as well as updates the realtime database
   * with latest call status
   * @param {object} opts
   * @param {string} callStatus - current call status
   * @param {number} sipStatus - current sip status
   * @param {number} [duration] - duration of a completed call, in seconds
   */
  _notifyCallStatusChange({callStatus, sipStatus, duration}) {
    if (this.callMoved) return;

    assert((typeof duration === 'number' && callStatus === CallStatus.Completed) ||
      (!duration && callStatus !== CallStatus.Completed),
    'duration MUST be supplied when call completed AND ONLY when call completed');

    this.callInfo.updateCallStatus(callStatus, sipStatus);
    if (typeof duration === 'number') this.callInfo.duration = duration;
    try {
      this.notifier.request(this.call_status_hook, this.callInfo);
    } catch (err) {
      this.logger.info(err, `CallSession:_notifyCallStatusChange error sending ${callStatus} ${sipStatus}`);
    }

    // update calls db
    //this.logger.debug(`updating redis with ${JSON.stringify(this.callInfo)}`);
    this.updateCallStatus(Object.assign({}, this.callInfo), this.serviceUrl)
      .catch((err) => this.logger.error(err, 'redis error'));
  }
}

module.exports = CallSession;
