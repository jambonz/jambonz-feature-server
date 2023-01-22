const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskHangup extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.headers = this.data.headers || {};

    this.preconditions = TaskPreconditions.StableCall;
  }

  get name() { return TaskName.Hangup; }

  /**
   * Hangup the call
   */
  async exec(cs, {dlg}) {
    await super.exec(cs);
    try {
      await dlg.destroy({headers: this.headers});
      cs._callReleased();
    } catch (err) {
      this.logger.error(err, 'TaskHangup:exec - Error hanging up call');
    }
  }
}

module.exports = TaskHangup;
