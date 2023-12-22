const { normalizeJambones } = require('@jambonz/verb-specifications');
const makeTask = require('../tasks/make_task');
const { JAMBONZ_RECORD_WS_BASE_URL, JAMBONZ_RECORD_WS_USERNAME, JAMBONZ_RECORD_WS_PASSWORD } = require('../config');
const Emitter = require('events');

class BackgroundTaskManager extends Emitter {
  constructor({cs, logger, rootSpan}) {
    super();
    this.tasks = new Map();
    this.cs = cs;
    this.logger = logger;
    this.rootSpan = rootSpan;
  }

  isTaskRunning(type) {
    return this.tasks.has(type);
  }

  getTask(type) {
    if (this.tasks.has(type)) {
      return this.tasks.get(type);
    }
  }

  count() {
    return this.tasks.size;
  }

  async newTask(type, taskOpts, autorestart = false) {
    this.logger.info({taskOpts}, `initiating Background task ${type}`);
    if (this.tasks.has(type)) {
      this.logger.info(`Background task ${type} is running, skiped`);
      return;
    }
    let task;
    switch (type) {
      case 'listen':
        task = await this._initListen(taskOpts);
        break;
      case 'gather':
        task = await this._initGather(taskOpts, autorestart);
        break;
      case 'record':
        task = await this._initRecord();
        break;
      case 'transcribe':
        task = await this._initTranscribe();
        break;
      default:
        break;
    }
    if (task) {
      this.tasks.set(type, task);
    }
    return task;
  }

  stop(type) {
    const task = this.getTask(type);
    if (task) {
      this.logger.info(`stopping background task: ${type}`);
      task.removeAllListeners();
      task.span.end();
      task.kill().catch((err) => {
        this.logger.error(err, `There is error while killing background task ${type}`);
      });
      // Remove task from managed List
      this.tasks.delete(type);
    } else {
      this.logger.info(`stopping background task, ${type} is not running, skipped`);
    }
  }

  stopAll() {
    this.logger.info('BackgroundTaskManager:stopAll');
    for (const key of this.tasks.keys()) {
      this.stop(key);
    }
  }

  // Initiate Task
  // Initiate Listen
  async _initListen(opts, bugname = 'jambonz-background-listen', ignoreCustomerData = false, type = 'listen') {
    let task;
    try {
      const t = normalizeJambones(this.logger, [opts]);
      task = makeTask(this.logger, t[0]);
      task.bugname = bugname;
      task.ignoreCustomerData = ignoreCustomerData;
      const resources = await this.cs._evaluatePreconditions(task);
      const {span, ctx} = this.rootSpan.startChildSpan(`background-listen:${task.summary}`);
      task.span = span;
      task.ctx = ctx;
      task.exec(this, resources)
        .then(this._taskCompleted.bind(this, type, task))
        .catch(this._taskError.bind(this, type, task));
    } catch (err) {
      this.logger.info({err, opts}, `BackgroundTaskManager:_initListen - Error creating ${bugname} task`);
    }
    return task;
  }

  // Initiate Gather
  async _initGather(opts, autorestart = false) {
    let task;
    try {
      const t = normalizeJambones(this.logger, [opts]);
      task = makeTask(this.logger, t[0]);
      task
        .once('dtmf', this._gatherTaskCompleted.bind(this))
        .once('vad', this._gatherTaskCompleted.bind(this))
        .once('transcription', this._gatherTaskCompleted.bind(this))
        .once('timeout', this._gatherTaskCompleted.bind(this));
      const resources = await this._evaluatePreconditions(this.backgroundGatherTask);
      const {span, ctx} = this.rootSpan.startChildSpan(`background-gather:${this.backgroundGatherTask.summary}`);
      task.span = span;
      task.ctx = ctx;
      task.sticky = autorestart;
      task.exec(this, resources)
        .then(this._taskCompleted.bind(this, 'gather', task))
        .catch(this._taskError.bind(this, 'gather', task));
    } catch (err) {
      this.logger.info(err, 'BackgroundTaskManager:_initGather - Error creating gather task');
    }
    return task;
  }

  // Initiate Record
  async _initRecord() {
    if (this.cs.accountInfo.account.record_all_calls || this.cs.application.record_all_calls) {
      if (!JAMBONZ_RECORD_WS_BASE_URL || !this.cs.accountInfo.account.bucket_credential) {
        this.logger.error(`_initRecord: invalid configuration,
 missing JAMBONZ_RECORD_WS_BASE_URL or bucket configuration`);
        return undefined;
      }
      const listenOpts = {
        url: `${JAMBONZ_RECORD_WS_BASE_URL}/record/${this.cs.accountInfo.account.bucket_credential.vendor}`,
        disableBidirectionalAudio: true,
        mixType : 'stereo',
        passDtmf: true
      };
      if (JAMBONZ_RECORD_WS_USERNAME && JAMBONZ_RECORD_WS_PASSWORD) {
        listenOpts.wsAuth = {
          username: JAMBONZ_RECORD_WS_USERNAME,
          password: JAMBONZ_RECORD_WS_PASSWORD
        };
      }
      this.logger.debug({listenOpts}, '_initRecord: enabling listen');
      return await this._initListen({verb: 'listen', ...listenOpts}, 'jambonz-session-record', true, 'record');
    }
  }

  // Initiate Transcribe
  async _initTranscribe(opts) {
    let task;
    try {
      const t = normalizeJambones(this.logger, [opts]);
      task = makeTask(this.logger, t[0]);
      const resources = await this._evaluatePreconditions(this.backgroundGatherTask);
      const {span, ctx} = this.rootSpan.startChildSpan(`background-gather:${this.backgroundGatherTask.summary}`);
      task.span = span;
      task.ctx = ctx;
      task.exec(this, resources)
        .then(this._taskCompleted.bind(this, 'transcribe', task))
        .catch(this._taskError.bind(this, 'transcribe', task));
    } catch (err) {
      this.logger.info(err, 'BackgroundTaskManager:_initGather - Error creating transcribe task');
    }
    return task;
  }

  _taskCompleted(type, task) {
    this.logger.info(task, 'BackgroundTaskManager:_taskCompleted: task completed');
    task.removeAllListeners();
    task.span.end();
    this.tasks.delete(type);
  }
  _taskError(type, task, error) {
    this.logger.info({task, error}, 'BackgroundTaskManager:_taskError: task Error');
    task.removeAllListeners();
    task.span.end();
    this.tasks.delete(type);
  }

  _gatherTaskCompleted(evt) {
    this.logger.info({evt}, 'BackgroundTaskManager:_clearGatherTask on event from background gather');
    this.emit('gather-done', evt);
  }
}

module.exports = BackgroundTaskManager;
