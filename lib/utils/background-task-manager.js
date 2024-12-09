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

  async newTask(type, opts, sticky = false) {
    this.logger.info({opts}, `initiating Background task ${type}`);
    if (this.tasks.has(type)) {
      this.logger.info(`Background task ${type} is running, skipped`);
      return;
    }
    let task;
    switch (type) {
      case 'listen':
        task = await this._initListen(opts);
        break;
      case 'bargeIn':
        task = await this._initBargeIn(opts);
        break;
      case 'record':
        task = await this._initRecord();
        break;
      case 'transcribe':
        task = await this._initTranscribe(opts);
        break;
      case 'ttsStream':
        task = await this._initTtsStream(opts);
        break;
      default:
        break;
    }
    if (task) {
      this.tasks.set(type, task);
    }
    if (task && sticky) task.sticky = true;
    return task;
  }

  stop(type) {
    const task = this.getTask(type);
    if (task) {
      this.logger.info(`stopping background task: ${type}`);
      task.removeAllListeners();
      task.span.end();
      task.kill();
      // Remove task from managed List
      this.tasks.delete(type);
    }
  }

  stopAll() {
    this.logger.debug('BackgroundTaskManager:stopAll');
    for (const key of this.tasks.keys()) {
      this.stop(key);
    }
  }

  // Initiate Listen
  async _initListen(opts, bugname = 'jambonz-background-listen', ignoreCustomerData = false, type = 'listen') {
    let task;
    try {
      const t = normalizeJambones(this.logger, [opts]);
      task = makeTask(this.logger, t[0]);
      task.bugname = bugname;
      task.ignoreCustomerData = ignoreCustomerData;
      const resources = await this.cs._evaluatePreconditions(task);
      const {span, ctx} = this.rootSpan.startChildSpan(`background-${type}:${task.summary}`);
      task.span = span;
      task.ctx = ctx;
      task.exec(this.cs, resources)
        .then(this._taskCompleted.bind(this, type, task))
        .catch(this._taskError.bind(this, type, task));
    } catch (err) {
      this.logger.info({err, opts}, `BackgroundTaskManager:_initListen - Error creating ${bugname} task`);
    }
    return task;
  }

  // Initiate Gather
  async _initBargeIn(opts) {
    let task;
    try {
      const t = normalizeJambones(this.logger, [opts]);
      task = makeTask(this.logger, t[0]);
      task
        .once('dtmf', this._bargeInTaskCompleted.bind(this))
        .once('vad', this._bargeInTaskCompleted.bind(this))
        .once('transcription', this._bargeInTaskCompleted.bind(this))
        .once('timeout', this._bargeInTaskCompleted.bind(this));
      const resources = await this.cs._evaluatePreconditions(task);
      const {span, ctx} = this.rootSpan.startChildSpan(`background-bargeIn:${task.summary}`);
      task.span = span;
      task.ctx = ctx;
      task.bugname_prefix = 'background_bargeIn_';
      task.exec(this.cs, resources)
        .then(() => {
          this._taskCompleted('bargeIn', task);
          if (task.sticky && !this.cs.callGone && !this.cs._stopping) {
            this.logger.info('BackgroundTaskManager:_initBargeIn: restarting background bargeIn');
            this._bargeInHandled = false;
            this.newTask('bargeIn', opts, true);
          }
          return;
        })
        .catch(this._taskError.bind(this, 'bargeIn', task));
    } catch (err) {
      this.logger.info(err, 'BackgroundTaskManager:_initGather - Error creating bargeIn task');
    }
    return task;
  }

  // Initiate Record
  async _initRecord() {
    if (this.cs.accountInfo.account.record_all_calls || this.cs.application.record_all_calls) {
      if (!JAMBONZ_RECORD_WS_BASE_URL || !this.cs.accountInfo.account.bucket_credential) {
        this.logger.error('_initRecord: invalid cfg - missing JAMBONZ_RECORD_WS_BASE_URL or bucket config');
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
      const resources = await this.cs._evaluatePreconditions(task);
      const {span, ctx} = this.rootSpan.startChildSpan(`background-transcribe:${task.summary}`);
      task.span = span;
      task.ctx = ctx;
      task.bugname_prefix = 'background_transcribe_';
      task.exec(this.cs, resources)
        .then(this._taskCompleted.bind(this, 'transcribe', task))
        .catch(this._taskError.bind(this, 'transcribe', task));
    } catch (err) {
      this.logger.info(err, 'BackgroundTaskManager:_initTranscribe - Error creating transcribe task');
    }
    return task;
  }

  // Initiate Tts Stream
  async _initTtsStream(opts) {
    let task;
    try {
      const t = normalizeJambones(this.logger, [opts]);
      task = makeTask(this.logger, t[0]);
      const resources = await this.cs._evaluatePreconditions(task);
      const {span, ctx} = this.rootSpan.startChildSpan(`background-ttsStream:${task.summary}`);
      task.span = span;
      task.ctx = ctx;
      task.exec(this.cs, resources)
        .then(this._taskCompleted.bind(this, 'ttsStream', task))
        .catch(this._taskError.bind(this, 'ttsStream', task));
    } catch (err) {
      this.logger.info(err, 'BackgroundTaskManager:_initTtsStream - Error creating ttsStream task');
    }
    return task;
  }

  _taskCompleted(type, task) {
    this.logger.debug({type, task}, `BackgroundTaskManager:_taskCompleted: task completed, sticky: ${task.sticky}`);
    task.removeAllListeners();
    task.span.end();
    this.tasks.delete(type);
  }
  _taskError(type, task, error) {
    this.logger.info({type, task, error}, 'BackgroundTaskManager:_taskError: task Error');
    task.removeAllListeners();
    task.span.end();
    this.tasks.delete(type);
  }

  _bargeInTaskCompleted(evt) {
    if (this._bargeInHandled) return;
    this._bargeInHandled = true;
    this.logger.debug({evt},
      'BackgroundTaskManager:_bargeInTaskCompleted on event from background bargeIn, emitting bargein-done event');
    this.emit('bargeIn-done', evt);
  }
}

module.exports = BackgroundTaskManager;
