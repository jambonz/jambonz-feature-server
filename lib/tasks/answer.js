const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

/**
 * Answer the call.
 * Note: This is rarely used, as the call is typically answered automatically when required by the app,
 * but it can be useful to force an answer before a pause in some cases
 */
class TaskAnswer extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;
  }

  get name() { return TaskName.Answer; }

  async exec(cs) {
    super.exec(cs);
  }
}

module.exports = TaskAnswer;
