const Emitter = require('events');
const uuidv4 = require('uuid-random');
const {TaskPreconditions} = require('../utils/constants');
const { normalizeJambones } = require('@jambonz/verb-specifications');
const WsRequestor = require('../utils/ws-requestor');
const {TaskName} = require('../utils/constants');
const {trace} = require('@opentelemetry/api');

/**
 * @classdesc Represents a jambonz verb. This is a superclass that is extended
 * by a subclass for each verb.
 * @extends Emitter
 */
class Task extends Emitter {
  constructor(logger, data) {
    super();
    this.preconditions = TaskPreconditions.None;
    this.logger = logger;
    this.data = data;
    this.actionHook = this.data.actionHook;
    this.id = data.id;

    this._killInProgress = false;
    this._completionPromise = new Promise((resolve) => this._completionResolver = resolve);

    /* used when we play a prompt to a member in conference */
    this._confPlayCompletionPromise = new Promise((resolve) => this._confPlayCompletionResolver = resolve);
  }

  /**
   * @property {boolean} killed - true if the task has been killed
   */
  get killed() {
    return this._killInProgress;
  }

  /**
   * @property {CallSession} callSession - the CallSession this task is executing within
   */
  get callSession() {
    return this.cs;
  }

  get summary() {
    return this.name;
  }

  toJSON() {
    return this.data;
  }

  /**
   * Execute the task.  Subclasses must implement this method, but should always call
   * the superclass implementation first.
   * @param {CallSession} cs - the CallSession that the Task will be executing within.
   */
  async exec(cs) {
    this.cs = cs;
  }

  /**
   * called to kill (/stop) a running task
   * what to do is up to each type of task
   */
  kill(cs) {
    if (this.cs && !this.cs.isConfirmCallSession) this.logger.debug(`${this.name} is being killed`);
    this._killInProgress = true;

    /* remove reference to parent task or else entangled parent-child tasks will not be gc'ed */
    setImmediate(() => this.parentTask = null);
  }

  startSpan(name, attributes) {
    const {srf} = require('../..');
    const {tracer} = srf.locals.otel;
    const span = tracer.startSpan(name, undefined, this.ctx);
    if (attributes) span.setAttributes(attributes);
    trace.setSpan(this.ctx, span);
    return span;
  }

  startChildSpan(name, attributes) {
    const {srf} = require('../..');
    const {tracer} = srf.locals.otel;
    const span = tracer.startSpan(name, undefined, this.ctx);
    if (attributes) span.setAttributes(attributes);
    const ctx = trace.setSpan(this.ctx, span);
    return {span, ctx};
  }

  getTracingPropagation(encoding, span) {
    // TODO: support encodings beyond b3 https://github.com/openzipkin/b3-propagation
    if (span) {
      return `${span.spanContext().traceId}-${span.spanContext().spanId}-1`;
    }
    if (this.span) {
      return `${this.span.spanContext().traceId}-${this.span.spanContext().spanId}-1`;
    }
  }

  /**
   * when a subclass Task has completed its work, it should call this method
   */
  notifyTaskDone() {
    this._completionResolver();
  }

  /**
   * when a subclass task has launched various async activities and is now simply waiting
   * for them to complete it should call this method to block until that happens
   */
  awaitTaskDone() {
    return this._completionPromise;
  }

  /**
   * when a play to conference member completes
   */
  notifyConfPlayDone() {
    this._confPlayCompletionResolver();
  }

  /**
   * when a subclass task has launched various async activities and is now simply waiting
   * for them to complete it should call this method to block until that happens
   */
  awaitConfPlayDone() {
    return this._confPlayCompletionPromise;
  }

  /**
   * provided as a convenience for tasks, this simply calls CallSession#normalizeUrl
   */
  normalizeUrl(url, method, auth) {
    return this.callSession.normalizeUrl(url, method, auth);
  }

  notifyError(obj) {
    if (this.cs.requestor instanceof WsRequestor) {
      const params = {...obj, verb: this.name, id: this.id};
      this.cs.requestor.request('jambonz:error', '/error', params)
        .catch((err) => this.logger.info({err}, 'Task:notifyError error sending error'));
    }
  }

  notifyStatus(obj) {
    if (this.cs.notifyEvents && this.cs.requestor instanceof WsRequestor) {
      const params = {...obj, verb: this.name, id: this.id};
      this.cs.requestor.request('verb:status', '/status', params)
        .catch((err) => this.logger.info({err}, 'Task:notifyStatus error sending error'));
    }
  }

  async performAction(results, expectResponse = true) {
    if (this.actionHook) {
      const type = this.name === TaskName.Redirect ? 'session:redirect' : 'verb:hook';
      const params = results ? Object.assign(this.cs.callInfo.toJSON(), results) : this.cs.callInfo.toJSON();
      const span = this.startSpan(`${type} (${this.actionHook})`);
      const b3 = this.getTracingPropagation('b3', span);
      const httpHeaders = b3 && {b3};
      span.setAttributes({'http.body': JSON.stringify(params)});
      try {
        if (this.id) params.verb_id = this.id;
        const json = await this.cs.requestor.request(type, this.actionHook, params, httpHeaders);
        span.setAttributes({'http.statusCode': 200});
        const isWsConnection = this.cs.requestor instanceof WsRequestor;
        if (!isWsConnection || (expectResponse && json && Array.isArray(json) && json.length)) {
          span.end();
        } else {
          /** we use this span to measure application response latency,
           * and with websocket connections we generally get the application's response
           * in a subsequent message from the far end, so we terminate the span when the
           * first new set of verbs arrive after sending a transcript
           * */
          this.emit('VerbHookSpanWaitForEnd', {span});
        }
        if (expectResponse && json && Array.isArray(json)) {
          const makeTask = require('./make_task');
          const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
          if (tasks && tasks.length > 0) {
            this.callSession.replaceApplication(tasks);
          }
        }
      } catch (err) {
        span.setAttributes({'http.statusCode': err.statusCode});
        span.end();
        throw err;
      }
    }
  }

  async performHook(cs, hook, results) {
    const params = results ? Object.assign(cs.callInfo.toJSON(), results) : cs.callInfo.toJSON();
    const span = this.startSpan('verb:hook', {'hook.url': hook});
    const b3 = this.getTracingPropagation('b3', span);
    const httpHeaders = b3 && {b3};
    span.setAttributes({'http.body': JSON.stringify(params)});
    try {
      const json = await cs.requestor.request('verb:hook', hook, params, httpHeaders);
      span.setAttributes({'http.statusCode': 200});
      span.end();
      if (json && Array.isArray(json)) {
        const makeTask = require('./make_task');
        const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
        if (tasks && tasks.length > 0) {
          this.redirect(cs, tasks);
          return true;
        }
      }
      return false;
    } catch (err) {
      span.setAttributes({'http.statusCode': err.statusCode});
      span.end();
      throw err;
    }
  }

  redirect(cs, tasks) {
    this.logger.info({tasks: tasks}, `${this.name} replacing application with ${tasks.length} tasks`);
    this.isReplacingApplication = true;
    cs.replaceApplication(tasks);
  }

  async playToConfMember(ep, memberId, confName, confUuid, filepath) {
    try {
      this.logger.debug(`Task:playToConfMember - playing ${filepath} to ${confName}:${memberId}`);

      // listen for conference events
      const handler = this.__onConferenceEvent.bind(this);
      ep.conn.on('esl::event::CUSTOM::*', handler) ;
      const response = await ep.api(`conference ${confName} play ${filepath} ${memberId}`);
      this.logger.debug({response}, 'Task:playToConfMember - api call returned');
      await this.awaitConfPlayDone();
      ep.conn.removeListener('esl::event::CUSTOM::*', handler);
    } catch (err) {
      this.logger.error({err}, `Task:playToConfMember - error playing ${filepath} to ${confName}:${memberId}`);
    }
  }

  async killPlayToConfMember(ep, memberId, confName) {
    try {
      this.logger.debug(`Task:killPlayToConfMember - killing audio to ${confName}:${memberId}`);
      const response = await ep.api(`conference ${confName} stop ${memberId}`);
      this.logger.debug({response}, 'Task:killPlayToConfMember - api call returned');
    } catch (err) {
      this.logger.error({err}, `Task:killPlayToConfMember - error killing audio to ${confName}:${memberId}`);
    }
  }

  __onConferenceEvent(evt) {
    const eventName = evt.getHeader('Event-Subclass') ;
    if (eventName === 'conference::maintenance') {
      const action = evt.getHeader('Action') ;
      if (action === 'play-file-member-done') {
        this.logger.debug('done playing file to conf member');
        this.notifyConfPlayDone();
      }
    }
  }

  async transferCallToFeatureServer(cs, sipAddress, opts) {
    const uuid = uuidv4();
    const {addKey} = cs.srf.locals.dbHelpers;
    const obj = Object.assign({}, cs.application);
    delete obj.requestor;
    delete obj.notifier;
    obj.tasks =  cs.getRemainingTaskData();
    if (opts && obj.tasks.length > 0) {
      const key = Object.keys(obj.tasks[0])[0];
      Object.assign(obj.tasks[0][key], {_: opts});
    }

    this.logger.debug({obj}, 'Task:_doRefer - final object to store for receiving session on othe server');

    const success = await addKey(uuid, JSON.stringify(obj), 30);
    if (!success) {
      this.logger.info(`Task:_doRefer failed storing task data before REFER for ${this.queueName}`);
      return;
    }
    try {
      this.logger.info(`Task:_doRefer: referring call to ${sipAddress} for ${this.queueName}`);
      this.callMoved = true;
      const success = await cs.referCall(`sip:context-${uuid}@${sipAddress}`);
      if (!success) {
        this.callMoved = false;
        this.logger.info('Task:_doRefer REFER failed');
        return success;
      }
      this.logger.info('Task:_doRefer REFER succeeded');
      return success;
    } catch (err) {
      this.logger.error(err, 'Task:_doRefer error');
    }
  }
}

module.exports = Task;

