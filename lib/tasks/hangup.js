const Task = require('./task');
const {TaskName} = require('../utils/constants');

class TaskHangup extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.headers = this.data.headers || {};
  }

  get name() { return TaskName.Hangup; }

  /**
   * Hangup the call
   */
  async exec(cs, dlg) {
    try {
      await dlg.destroy({headers: this.headers});
    } catch (err) {
      this.logger.error(err, `TaskHangup:exec - Error hanging up call with sip call id ${dlg.sip.callId}`);
    }
  }
}

module.exports = TaskHangup;
