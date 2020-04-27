const Task = require('./task');
const {TaskName} = require('../utils/constants');
const makeTask = require('./make_task');
const normalizeJambones = require('../utils/normalize-jambones');

/**
 * Manages an outdial made via REST API
 */
class TaskRestDial extends Task {
  constructor(logger, opts) {
    super(logger, opts);

    this.from = this.data.from;
    this.to = this.data.to;
    this.call_hook = this.data.call_hook;
    this.timeout = this.data.timeout || 60;

    this.on('connect', this._onConnect.bind(this));
    this.on('callStatus', this._onCallStatus.bind(this));
  }

  get name() { return TaskName.RestDial; }

  /**
   * INVITE has just been sent at this point
  */
  async exec(cs) {
    await super.exec(cs);
    this.req = cs.req;

    this._setCallTimer();
    await this.awaitTaskDone();
  }

  kill(cs) {
    super.kill(cs);
    this._clearCallTimer();
    if (this.req) {
      this.req.cancel();
      this.req = null;
    }
    this.notifyTaskDone();
  }

  async _onConnect(dlg) {
    this.req = null;
    const cs = this.callSession;
    cs.setDialog(dlg);

    try {
      const tasks = await cs.requestor.request(this.call_hook, cs.callInfo);
      if (tasks && Array.isArray(tasks)) {
        this.logger.debug({tasks: tasks}, `TaskRestDial: replacing application with ${tasks.length} tasks`);
        cs.replaceApplication(normalizeJambones(this.logger, tasks).map((tdata) => makeTask(this.logger, tdata)));
      }
    } catch (err) {
      this.logger.error(err, 'TaskRestDial:_onConnect error retrieving or parsing application, ending call');
      this.notifyTaskDone();
    }
  }

  _onCallStatus(status) {
    this.logger.debug(`CallStatus: ${status}`);
    if (status >= 200) {
      this.req = null;
      this._clearCallTimer();
      if (status !== 200) this.notifyTaskDone();
    }
  }

  _setCallTimer() {
    this.timer = setTimeout(this._onCallTimeout.bind(this), this.timeout * 1000);
  }

  _clearCallTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  _onCallTimeout() {
    this.logger.debug('TaskRestDial: timeout expired without answer, killing task');
    this.timer = null;
    this.kill();
  }
}

module.exports = TaskRestDial;
