const Task = require('./task');
const {TaskName} = require('../utils/constants');

class TaskLeave extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
  }

  get name() { return TaskName.Leave; }

  async exec(cs, {ep}) {
    await super.exec(cs);
    await this.awaitTaskDone();
  }

  async kill(cs) {
    super.kill(cs);
    this.notifyTaskDone();
  }
}

module.exports = TaskLeave;
