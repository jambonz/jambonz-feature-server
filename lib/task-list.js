class TaskList {
  constructor(tasks, callSid) {
    this.tasks = tasks;
    this.callSid = callSid;
  }

  shift() {
    const task = this.tasks.shift();
    if (task) return {task, callSid: this.callSid};
  }

  get length() {
    return this.tasks.length;
  }
}

module.exports = TaskList;
