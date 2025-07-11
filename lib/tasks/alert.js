const Task = require('./task');
const {TaskName} = require('../utils/constants');

class TaskAlert extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.message = this.data.message;
  }

  get name() { return TaskName.Alert; }

  async exec(cs) {
    const {srf, accountSid:account_sid, callSid:target_sid, applicationSid:application_sid} = cs;
    const {writeAlerts, AlertType} = srf.locals;
    await super.exec(cs);
    writeAlerts({
      account_sid,
      alert_type: AlertType.APPLICATION,
      detail: `Application SID ${application_sid}`,
      message: this.message,
      target_sid
    }).catch((err) => this.logger.info({err}, 'Error generating alert application'));
  }

  async kill(cs) {
    super.kill(cs);
    this.notifyTaskDone();
  }
}

module.exports = TaskAlert;
