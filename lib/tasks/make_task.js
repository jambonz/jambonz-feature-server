const Task = require('./task');
const TaskSipDecline = require('./sip_decline');
const TaskDial = require('./dial');
const errBadInstruction = new Error('invalid instruction payload');

function makeTask(logger, opts) {
  if (typeof opts !== 'object' || Array.isArray(opts)) throw errBadInstruction;
  const keys = Object.keys(opts);
  if (keys.length !== 1) throw errBadInstruction;
  const name = keys[0];
  const data = opts[name];
  Task.validate(name, data);
  switch (name) {
    case TaskSipDecline.name: return new TaskSipDecline(logger, data);
    case TaskDial.name: return new TaskDial(logger, data);
  }

  // should never reach
  throw new Error(`invalid task ${name} (please update specs.json and make_task.js)`);
}

module.exports = makeTask;
