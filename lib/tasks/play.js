const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskPlay extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.url = this.data.url;
    this.loop = this.data.loop || 1;
    this.earlyMedia = this.data.earlyMedia === true;
    this.playComplete = false;
  }

  get name() { return TaskName.Play; }

  async exec(cs, ep) {
    this.ep = ep;
    try {
      while (!this.playComplete && this.loop--) {
        await ep.play(this.url);
      }
    } catch (err) {
      this.logger.info(err, `TaskPlay:exec - error playing ${this.url}`);
    }
    this.playComplete = true;
    this.emit('playDone');
  }

  kill() {
    super.kill();
    if (this.ep.connected && !this.playComplete) {
      this.logger.debug('TaskPlay:kill - killing audio');
      this.playComplete = true;
      this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
    }
  }
}

module.exports = TaskPlay;
