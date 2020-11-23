const Task = require('./task');
const {TaskName, TaskPreconditions, CallStatus} = require('../utils/constants');

/**
 * Rejects an incoming call with user-specified status code and reason
 */
class TaskSipDecline extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.UnansweredCall;

    this.headers = this.data.headers || {};
  }

  get name() { return TaskName.SipDecline; }

  async exec(cs, {res}) {
    super.exec(cs);
    res.send(this.data.status, this.data.reason, {
      headers: this.headers
    });
    cs.emit('callStatusChange', {callStatus: CallStatus.Failed, sipStatus: this.data.status});
  }
}

module.exports = TaskSipDecline;
