const Task = require('./task');
const {TaskName} = require('../utils/constants');

/**
 * Redirects to a new application
 */
class TaskRedirect extends Task {
  constructor(logger, opts) {
    super(logger, opts);

    this.action = this.data.action;
    this.method = (this.data.method || 'POST').toUpperCase();
    this.auth = this.data.auth;
  }

  get name() { return TaskName.Redirect; }

  async exec(cs) {
    super.exec(cs);
    await this.performAction(this.method, this.auth);
  }
}

module.exports = TaskRedirect;
