const Emitter = require('events');
const { v4: uuidv4 } = require('uuid');
const debug = require('debug')('jambonz:feature-server');
const assert = require('assert');
const {TaskPreconditions} = require('../utils/constants');
const normalizeJambones = require('../utils/normalize-jambones');
const specs = new Map();
const _specData = require('./specs');
for (const key in _specData) {specs.set(key, _specData[key]);}

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

    this._killInProgress = false;
    this._completionPromise = new Promise((resolve) => this._completionResolver = resolve);
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
    // no-op
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
   * provided as a convenience for tasks, this simply calls CallSession#normalizeUrl
   */
  normalizeUrl(url, method, auth) {
    return this.callSession.normalizeUrl(url, method, auth);
  }

  async performAction(results, expectResponse = true) {
    if (this.actionHook) {
      const params = results ? Object.assign(results, this.cs.callInfo.toJSON()) : this.cs.callInfo.toJSON();
      const json = await this.cs.requestor.request(this.actionHook, params);
      if (expectResponse && json && Array.isArray(json)) {
        const makeTask = require('./make_task');
        const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
        if (tasks && tasks.length > 0) {
          this.logger.info({tasks: tasks}, `${this.name} replacing application with ${tasks.length} tasks`);
          this.callSession.replaceApplication(tasks);
        }
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
    if (opts && obj.tasks.length > 1) {
      const key = Object.keys(obj.tasks[0])[0];
      Object.assign(obj.tasks[0][key], {_: opts});
    }

    this.logger.debug({obj}, 'Task:_doRefer');

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

  /**
   * validate that the JSON task description is valid
   * @param {string} name - verb name
   * @param {object} data - verb properties
   */
  static validate(name, data) {
    debug(`validating ${name} with data ${JSON.stringify(data)}`);
    // validate the instruction is supported
    if (!specs.has(name)) throw new Error(`invalid instruction: ${name}`);

    // check type of each element and make sure required elements are present
    const specData = specs.get(name);
    let required = specData.required || [];
    for (const dKey in data) {
      if (dKey in specData.properties) {
        const dVal = data[dKey];
        const dSpec = specData.properties[dKey];
        debug(`Task:validate validating property ${dKey} with value ${JSON.stringify(dVal)}`);

        if (typeof dSpec === 'string' && dSpec === 'array') {
          if (!Array.isArray(dVal)) throw new Error(`${name}: property ${dKey} is not an array`);
        }
        else if (typeof dSpec === 'string' && dSpec.includes('|')) {
          const types = dSpec.split('|').map((t) => t.trim());
          if (!types.includes(typeof dVal) && !(types.includes('array') && Array.isArray(dVal))) {
            throw new Error(`${name}: property ${dKey} has invalid data type, must be one of ${types}`);
          }
        }
        else if (typeof dSpec === 'string' && ['number', 'string', 'object', 'boolean'].includes(dSpec)) {
          // simple types
          if (typeof dVal !== specData.properties[dKey]) {
            throw new Error(`${name}: property ${dKey} has invalid data type`);
          }
        }
        else if (Array.isArray(dSpec) && dSpec[0].startsWith('#')) {
          const name = dSpec[0].slice(1);
          for (const item of dVal) {
            Task.validate(name, item);
          }
        }
        else if (typeof dSpec === 'object') {
          // complex types
          const type = dSpec.type;
          assert.ok(['number', 'string', 'object', 'boolean'].includes(type),
            `invalid or missing type in spec ${JSON.stringify(dSpec)}`);
          if (type === 'string' && dSpec.enum) {
            assert.ok(Array.isArray(dSpec.enum), `enum must be an array ${JSON.stringify(dSpec.enum)}`);
            if (!dSpec.enum.includes(dVal)) throw new Error(`invalid value ${dVal} must be one of ${dSpec.enum}`);
          }
        }
        else if (typeof dSpec === 'string' && dSpec.startsWith('#')) {
          // reference to another datatype (i.e. nested type)
          const name = dSpec.slice(1);
          //const obj = {};
          //obj[name] = dVal;
          Task.validate(name, dVal);
        }
        else {
          assert.ok(0, `invalid spec ${JSON.stringify(dSpec)}`);
        }
        required = required.filter((item) => item !== dKey);
      }
      else throw new Error(`${name}: unknown property ${dKey}`);
    }
    if (required.length > 0) throw new Error(`${name}: missing value for ${required}`);
  }
}

module.exports = Task;

