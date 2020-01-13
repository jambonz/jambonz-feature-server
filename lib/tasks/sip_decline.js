const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskSipDecline extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.UnansweredCall;

    this.headers = this.data.headers || {};
  }

  get name() { return TaskName.SipDecline; }

  /**
   * Reject an incoming call attempt with a provided status code and (optionally) reason
   */
  async exec(cs, {res}) {
    res.send(this.data.status, this.data.reason, {
      headers: this.headers
    });
  }
}

module.exports = TaskSipDecline;
