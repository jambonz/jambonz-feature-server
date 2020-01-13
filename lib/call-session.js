const Emitter = require('events');
const config = require('config');
const TaskList = require('./task-list');
const request = require('request');
const notifiers = require('./utils/notifiers');
const {CallStatus, CallDirection, TaskPreconditions} = require('./utils/constants');
//require('request-debug')(request);
const makeTask = require('./tasks/make_task');
const resourcesMixin = require('./utils/resources');
const moment = require('moment');
const assert = require('assert');
const BADPRECONDITIONS = 'preconditions not met';

class CallSession extends Emitter {
  constructor(req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = req.locals.logger;
    this.application = req.locals.application;
    this.statusCallback = this.application.call_status_hook;
    this.statusCallbackMethod = this.application.status_hook_http_method || 'POST';
    this.idxTask = 0;
    this.resources = new Map();
    this.direction = CallDirection.Inbound;
    this.callAttributes = req.locals.callAttributes;

    // array of TaskLists, the one currently executing is at the front
    this._executionStack = [new TaskList(this.application.tasks, this.callSid)];
    this.childCallSids = [];
    this.calls = new Map();
    this.calls.set(this.parentCallSid, {ep: null, dlg: null});

    this.hooks = notifiers(this.logger, this.callAttributes);

    req.on('cancel', this._onCallerHangup.bind(this));
    this.on('callStatusChange', this._onCallStatusChange.bind(this));
  }

  get callSid() { return this.callAttributes.CallSid; }
  get parentCallSid() { return this.callAttributes.CallSid; }
  get actionHook() { return this.hooks.actionHook; }

  async exec() {
    let idx = 0;
    while (this._executionStack.length) {
      const taskList = this.currentTaskList = this._executionStack.shift();
      this.logger.debug(`CallSession:exec starting task list with ${taskList.tasks.length} tasks`);
      while (taskList.length) {
        const {task, callSid} = taskList.shift();
        this.logger.debug(`CallSession:exec starting task #${++idx}: ${task.name}`);
        try {
          const resources = await this._evaluatePreconditions(task, callSid);
          await task.exec(this, resources);
          this.logger.debug(`CallSession:exec completed task #${idx}: ${task.name}`);
        } catch (err) {
          if (err.message.includes(BADPRECONDITIONS)) {
            this.logger.info(`CallSession:exec task #${idx}: ${task.name}: ${err.message}`);
          }
          else {
            this.logger.error(err, `Error executing task  #${idx}: ${task.name}`);
            break;
          }
        }
      }
    }

    // all done - cleanup
    this.logger.info('CallSession:exec finished all tasks');
    if (!this.res.finalResponseSent) {
      this.logger.info('CallSession:exec auto-generating non-success response to invite');
      this.res.send(603);
    }
    this._clearCalls();
    this.clearResources();  // still needed? ms may be only thing in here
  }

  _evaluatePreconditions(task, callSid) {
    switch (task.preconditions) {
      case TaskPreconditions.None:
        return;
      case TaskPreconditions.Endpoint:
        return this._evalEndpointPrecondition(task, callSid);
      case TaskPreconditions.StableCall:
        return this._evalStableCallPrecondition(task, callSid);
      case TaskPreconditions.UnansweredCall:
        return this._evalUnansweredCallPrecondition(task, callSid);
      default:
        assert(0, `invalid/unknown or missing precondition type ${task.preconditions} for task ${task.name}`);
    }
  }

  async _evalEndpointPrecondition(task, callSid) {
    const resources = this.calls.get(callSid);
    if (!resources) throw new Error(`task ${task.name} attempting to operate on unknown CallSid ${callSid}`);
    if (resources.ep) return resources.ep;

    try {
      // need to allocate an endpoint
      const mrf = this.srf.locals.mrf;
      let ms = this.getResource('ms');
      if (!ms) {
        ms = await mrf.connect(config.get('freeswitch'));
        this.addResource('ms', ms);
      }
      const ep = await ms.createEndpoint({remoteSdp: this.req.body});
      resources.ep = ep;
      if (task.earlyMedia && callSid === this.parentCallSid && this.req && !this.req.finalResponseSent) {
        this.res.send(183, {body: ep.local.sdp});
        this.calls.set(callSid, resources);
        return ep;
      }
      const uas = await this.srf.createUAS(this.req, this.res, {localSdp: ep.local.sdp});
      resources.dlg = uas;
      this.calls.set(callSid, resources);
      return ep;
    } catch (err) {
      this.logger.error(err, `Error attempting to allocate endpoint for for task ${task.name}`);
      throw new Error(`${BADPRECONDITIONS}: unable to allocate endpoint - callSid ${callSid}`);
    }
  }

  _evalStableCallPrecondition(task, callSid) {
    const resources = this.calls.get(callSid);
    if (!resources) throw new Error(`task ${task.name} attempting to operate on unknown callSid ${callSid}`);
    if (resources.dlg) throw new Error(`${BADPRECONDITIONS}: call was not answered - callSid ${callSid}`);
    return resources.dlg;
  }

  _evalUnansweredCallPrecondition(task, callSid) {
    if (callSid !== this.parentCallSid || !this.req) {
      throw new Error(`${BADPRECONDITIONS}: no inbound call - callSid ${callSid}`);
    }
    if (this.req.finalResponseSent) {
      throw new Error(`${BADPRECONDITIONS}: final sip status already sent - callSid ${callSid}`);
    }
    return {req: this.req, res: this.res};
  }

  _clearCalls() {
    for (const [callSid, resources] of Array.from(this.calls).reverse()) {
      try {
        this.logger.debug(`CallSession:_clearCalls clearing call sid ${callSid}`);
        [resources.ep, resources.dlg].forEach((r) => {
          if (r && r.connected) r.destroy();
        });
      } catch (err) {
        this.logger.error(err, `clearResources: clearing call sid ${callSid}`);
      }
    }
    this.calls.clear();
  }


  /**
   * retrieve the media server and endpoint for this call, allocate them if needed
   */
  async createOrRetrieveEpAndMs() {
    const mrf = this.srf.locals.mrf;
    let ms = this.getResource('ms');
    let ep = this.getResource('epIn');
    if (ms && ep) return {ms, ep};

    // get a media server
    if (!ms) {
      ms = await mrf.connect(config.get('freeswitch'));
      this.addResource('ms', ms);
    }
    if (!ep) {
      ep = await ms.createEndpoint({remoteSdp: this.req.body});
      this.addResource('epIn', ep);
    }
    return {ms, ep};
  }

  async connectInboundCallToIvr(earlyMedia = false) {

    // if this is not an inbound call scenario, nothing to do
    if (!this.parentCallSid) {
      this.logger.debug('CallSession:connectInboundCallToIvr - session was not triggered by an inbound call');
      return;
    }

    // check for a stable inbound call already connected to the ivr
    const ms = this.getResource('ms');
    const resources = this.calls.get(this.parentCallSid);
    if (ms && resources.ep && resources.dlg) {
      this.logger.debug('CallSession:connectInboundCallToIvr - inbound call already connected to IVR');
      return {ms, ep: resources.ep, dlg: resources.dlg};
    }

    // check for an early media connection, where caller wants same
    if (ms && resources.ep && earlyMedia) {
      this.logger.debug('CallSession:connectInboundCallToIvr - inbound call already has early media connection');
      return {ms, ep: resources.ep};
    }

    // ok, we need to connect the inbound call to the ivr
    try {
      assert(!this.req.finalResponseSent);
      this.logger.debug('CallSession:connectInboundCallToIvr - creating endpoint for inbound call');
      const {ep, ms} = await this.createOrRetrieveEpAndMs();

      if (earlyMedia) {
        this.res.send(183, {body: ep.local.sdp});
        this.calls.set(this.parentCallSid, {ep});
        return {ep, ms, res: this.res};
      }
      const dlg = await this.srf.createUAS(this.req, this.res, {localSdp: ep.local.sdp});
      this.calls.set(this.parentCallSid, {ep, dlg});
      return {ep, ms, dlg};
    } catch (err) {
      this.logger.error(err, 'CallSession:connectInboundCallToIvr error');
      throw err;
    }
  }

  async answerParentCall(remoteSdp) {
    assert(this.parentCallSid, 'CallSession:answerParentCall - no parent call sid');
    const resources = this.calls.get(this.parentCallSid);
    resources.dlg = await this.srf.createUAS(this.req, this.res, {localSdp: remoteSdp});
    resources.set(this.parentCallSid, resources);
  }

  /**
   * allocate a new endpoint for this call, caller's responsibility to destroy
   */
  async createEndpoint(remoteSdp) {
    try {
      let ms = this.getResource('ms');
      if (!ms) {
        const mrf = this.srf.locals.mrf;
        ms = await mrf.connect(config.get('freeswitch'));
        this.addResource('ms', ms);
      }
      const ep = await ms.createEndpoint({remoteSdp});
      return ep;
    } catch (err) {
      this.logger.error(err, `CallSession:createEndpoint: error creating endpoint for remoteSdp ${remoteSdp}`);
      throw err;
    }
  }

  /**
   * Replace the currently-executing application with a new application
   * NB: any tasks in the current stack that have not been executed are flushed
   * @param {object|array} payload - new application to execute
   */
  replaceApplication(payload) {
    const taskData = Array.isArray(payload) ? payload : [payload];
    const tasks = [];
    for (const t in taskData) {
      try {
        const task = makeTask(this.logger, taskData[t]);
        tasks.push(task);
      } catch (err) {
        this.logger.info({data: taskData[t]}, `invalid web callback payload: ${err.message}`);
        return;
      }
    }
    this.application.tasks = tasks;
    this.idxTask = 0;
    this.logger.debug(`CallSession:replaceApplication - set ${tasks.length} new tasks`);
  }

  /**
   * got CANCEL from inbound leg
   */
  _onCallerHangup(evt) {
    this.logger.debug('CallSession: caller hung before connection');
  }

  /**
   * got BYE from inbound leg
   */
  _onCallStatusChange(evt) {
    this.logger.debug(evt, 'CallSession:_onCallStatusChange');
    if (this.statusCallback) {
      if (evt.status === CallStatus.InProgress) this.connectTime = moment();
      const params = Object.assign(this.callAttributes, {CallStatus: evt.status, SipStatus: evt.sipStatus});
      if (evt.status === CallStatus.Completed) {
        const duration = moment().diff(this.connectTime, 'seconds');
        this.logger.debug(`CallSession:_onCallStatusChange duration was ${duration}`);
        Object.assign(params, {Duration: duration});
      }
      const opts = {
        url: this.statusCallback,
        method: this.statusCallbackMethod,
        json: true,
        qs: 'GET' === this.statusCallbackMethod ? params : null,
        body: 'POST' === this.statusCallbackMethod ? params : null
      };
      request(opts, (err) => {
        if (err) this.logger.info(`Error sending call status to ${this.statusCallback}: ${err.message}`);
      });
    }
  }
}

Object.assign(CallSession.prototype, resourcesMixin);

module.exports = CallSession;
