const Task = require('./task');
const {TaskName} = require('../utils/constants');

class TaskPause extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);

    this.length = this.data.length;
  }

  get name() { return TaskName.Pause; }

  async exec(cs) {
    await super.exec(cs);
    this.timer = setTimeout(this.notifyTaskDone.bind(this), this.length * 1000);
    await this.awaitTaskDone();
  }

  async kill(cs) {
    super.kill(cs);
    clearTimeout(this.timer);
    this.notifyTaskDone();
  }
}

module.exports = TaskPause;
