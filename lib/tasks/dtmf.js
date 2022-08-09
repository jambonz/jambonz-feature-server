const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskDtmf extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.dtmf = this.data.dtmf;
    this.duration = this.data.duration || 500;
  }

  get name() { return TaskName.Dtmf; }

  async exec(cs, {ep}) {
    await super.exec(cs);
    this.ep = ep;
    try {
      this.logger.info({data: this.data}, `sending dtmf ${this.dtmf}`);
      await this.ep.execute('send_dtmf', `${this.dtmf}@${this.duration}`);
      this.timer = setTimeout(this.notifyTaskDone.bind(this), this.dtmf.length * (this.duration + 250) + 750);
      await this.awaitTaskDone();
      this.logger.info({data: this.data}, `done sending dtmf ${this.dtmf}`);
    } catch (err) {
      this.logger.info(err, `TaskDtmf:exec - error playing ${this.dtmf}`);
    }
    this.emit('playDone');
  }

  async kill(cs) {
    super.kill(cs);
    if (this.ep.connected && !this.playComplete) {
      this.logger.debug('TaskDtmf:kill - killing audio');
      await this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
    }
    clearTimeout(this.timer);
    this.notifyTaskDone();
  }
}

module.exports = TaskDtmf;
