const Task = require('./task');
const name = 'sip:decline';

class TaskSipDecline extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.name = name;
    this.headers = this.data.headers || {};
  }

  static get name() { return name; }

  /**
   * Reject an incoming call attempt with a provided status code and (optionally) reason
   */
  async exec(cs) {
    if (!cs.res.finalResponseSent) {
      cs.res.send(this.data.status, this.data.reason, {
        headers: this.headers
      });
    }
    return false;
  }
}

module.exports = TaskSipDecline;
