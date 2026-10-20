const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskHangup extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.headers = this.data.headers || {};

    // not StableCall: an unanswered (early media) call must be hangable too
    this.preconditions = TaskPreconditions.None;
  }

  get name() { return TaskName.Hangup; }

  /**
   * Hangup the call
   */
  async exec(cs) {
    await super.exec(cs);
    const {dlg} = cs;
    if (!dlg) {
      if (cs.res && !cs.res.finalResponseSent) {
        // ending the session rejects the INVITE (603) and reports 'failed'
        this.logger.info('TaskHangup:exec - call not answered, rejecting it');
        cs._callReleased();
      }
      else this.logger.info('TaskHangup:exec - no dialog to hang up');
      return;
    }
    try {
      await dlg.destroy({headers: this.headers});
      cs._callReleased();
    } catch (err) {
      this.logger.error(err, 'TaskHangup:exec - Error hanging up call');
    }
  }
}

module.exports = TaskHangup;
