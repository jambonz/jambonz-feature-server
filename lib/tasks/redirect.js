const Task = require('./task');
const {TaskName} = require('../utils/constants');

/**
 * Redirects to a new application
 */
class TaskRedirect extends Task {
  constructor(logger, opts) {
    super(logger, opts);
  }

  get name() { return TaskName.Redirect; }

  async exec(cs) {
    await super.exec(cs);
    await this.performAction();
  }
}

module.exports = TaskRedirect;
