const Task = require('./task');
const {TaskName} = require('../utils/constants');

class TaskTag extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.data = this.data.data;
  }

  get name() { return TaskName.Tag; }

  async exec(cs) {
    super.exec(cs);
    cs.callInfo.customerData = this.data;
    this.logger.debug({customerData: cs.callInfo.customerData}, 'TaskTag:exec set customer data in callInfo');
  }
}

module.exports = TaskTag;
