const Emitter = require('events');
const config = require('config');
const {CallDirection, TaskPreconditions, CallStatus} = require('../utils/constants');
const hooks = require('../utils/notifiers');
const moment = require('moment');
const assert = require('assert');
const BADPRECONDITIONS = 'preconditions not met';

class CallSession extends Emitter {
  constructor({logger, application, srf, tasks, callInfo}) {
    super();
    this.logger = logger;
    this.application = application;
    this.srf = srf;
    this.callInfo = callInfo;
    this.tasks = tasks;

    const {notifyHook} = hooks(this.logger, this.callInfo);
    this.notifyHook = notifyHook;

    this.taskIdx = 0;
    this.stackIdx = 0;
    this.callGone = false;
  }

  get callSid() {
    return this.callInfo.callSid;
  }

  get originalRequest() {
    return this.application.originalRequest;
  }

  get direction() {
    return this.callInfo.direction;
  }

  get callId() {
    return this.callInfo.direction;
  }

  get call_status_hook() {
    return this.application.call_status_hook;
  }

  get speechSynthesisVendor() {
    return this.application.speech_synthesis_vendor;
  }
  get speechSynthesisVoice() {
    return this.application.speech_synthesis_voice;
  }

  get speechRecognizerVendor() {
    return this.application.speech_recognizer_vendor;
  }
  get speechRecognizerLanguage() {
    return this.application.speech_recognizer_language;
  }

  async exec() {
    this.logger.info(`CallSession:exec starting task list with ${this.tasks.length} tasks`);
    while (this.tasks.length && !this.callGone) {
      const taskNum = ++this.taskIdx;
      const stackNum = this.stackIdx;
      const task = this.tasks.shift();
      this.logger.debug({task}, `CallSession:exec starting task #${stackNum}:${taskNum}: ${task.name}`);
      try {
        const resources = await this._evaluatePreconditions(task);
        this.currentTask = task;
        await task.exec(this, resources);
        this.currentTask = null;
        this.logger.debug(`CallSession:exec completed task #${stackNum}:${taskNum}: ${task.name}`);
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
    this._clearCalls();
    this.ms && this.ms.destroy();
  }

  _onTasksDone() {
    // meant to be implemented by subclass if needed
  }

  _callReleased() {
    this.logger.debug('CallSession:_callReleased - caller hung up');
    this.callGone = true;
    if (this.currentTask) this.currentTask.kill();
  }

  /**
   * Replace the currently-executing application with a new application
   * NB: any tasks in the current stack that have not been executed are flushed
   */
  replaceApplication(tasks) {
    this.tasks = tasks;
    this.logger.info({tasks}, `CallSession:replaceApplication - reset application with ${tasks.length} new tasks`);
    this.taskIdx = 0;
    this.stackIdx++;
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

  async _evalEndpointPrecondition(task) {
    if (this.callGone) new Error(`${BADPRECONDITIONS}: call gone`);

    const answerCall = async() => {
      const uas = await this.srf.createUAS(this.req, this.res, {localSdp: this.ep.local.sdp});
      uas.on('destroy', this._callerHungup.bind(this));
      uas.callSid = this.callSid;
      uas.connectTime = moment();
      this.dlg = uas;
      this.emit('callStatusChange', {sipStatus: 200, callStatus: CallStatus.InProgress});
      this.logger.debug('CallSession:_evalEndpointPrecondition - answered call');
    };

    if (this.ep) {
      if (!task.earlyMedia || this.dlg) return this.ep;

      // we are going from an early media connection to answer
      await answerCall();
    }

    try {
      // need to allocate an endpoint
      if (!this.ms) this.ms = await this.getMS();
      const ep = await this.ms.createEndpoint({remoteSdp: this.req.body});
      ep.cs = this;
      this.ep = ep;

      if (this.direction === CallDirection.Inbound) {
        if (task.earlyMedia && !this.req.finalResponseSent) {
          this.res.send(183, {body: ep.local.sdp});
          return ep;
        }
        answerCall();
      }
      else {
        // outbound call TODO
      }

      return ep;
    } catch (err) {
      this.logger.error(err, `Error attempting to allocate endpoint for for task ${task.name}`);
      throw new Error(`${BADPRECONDITIONS}: unable to allocate endpoint`);
    }
  }

  _evalStableCallPrecondition(task) {
    if (this.callGone) throw new Error(`${BADPRECONDITIONS}: call gone`);
    if (!this.dlg) throw new Error(`${BADPRECONDITIONS}: call was not answered`);
    return this.dlg;
  }

  _evalUnansweredCallPrecondition(task, callSid) {
    if (!this.req) throw new Error('invalid precondition unanswered_call for outbound call');
    if (this.callGone) new Error(`${BADPRECONDITIONS}: call gone`);
    if (this.req.finalResponseSent) {
      throw new Error(`${BADPRECONDITIONS}: final sip status already sent`);
    }
    return {req: this.req, res: this.res};
  }

  _clearCalls() {
    if (this.dlg && this.dlg.connected) this.dlg.destroy();
    if (this.ep && this.ep.connected) this.ep.destroy();
  }

  _callerHungup() {
    assert(false, 'subclass responsibility to override this method');
  }

  async getMS() {
    if (!this.ms) {
      const mrf = this.srf.locals.mrf;
      this.ms = await mrf.connect(config.get('freeswitch'));
    }
    return this.ms;
  }

  async createOrRetrieveEpAndMs() {
    const mrf = this.srf.locals.mrf;
    if (this.ms && this.ep) return {ms: this.ms, ep: this.ep};

    // get a media server
    if (!this.ms) {
      this.ms = await mrf.connect(config.get('freeswitch'));
    }
    if (!this.ep) {
      this.ep = await this.ms.createEndpoint({remoteSdp: this.req.body});
    }
    return {ms: this.ms, ep: this.ep};
  }
  _notifyCallStatusChange({callStatus, sipStatus, duration}) {
    assert((typeof duration === 'number' && callStatus === CallStatus.Completed) ||
      (!duration && callStatus !== CallStatus.Completed),
    'duration MUST be supplied when call completed AND ONLY when call completed');

    const call_status_hook = this.call_status_hook;
    this.callInfo.updateCallStatus(callStatus, sipStatus);
    if (typeof duration === 'number') this.callInfo.duration = duration;
    try {
      if (call_status_hook) this.notifyHook(call_status_hook);
    } catch (err) {
      this.logger.info(err, `CallSession:_notifyCallStatusChange error sending ${callStatus} ${sipStatus}`);
    }
  }
}

module.exports = CallSession;
