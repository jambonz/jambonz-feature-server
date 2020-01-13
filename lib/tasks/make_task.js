const Task = require('./task');
const {TaskName} = require('../utils/constants');
const errBadInstruction = new Error('invalid instruction payload');

function makeTask(logger, opts) {
  logger.debug(opts, 'makeTask');
  if (typeof opts !== 'object' || Array.isArray(opts)) throw errBadInstruction;
  const keys = Object.keys(opts);
  if (keys.length !== 1) throw errBadInstruction;
  const name = keys[0];
  const data = opts[name];
  Task.validate(name, data);
  switch (name) {
    case TaskName.SipDecline:
      const TaskSipDecline = require('./sip_decline');
      return new TaskSipDecline(logger, data);
    case TaskName.Dial:
      const TaskDial = require('./dial');
      return new TaskDial(logger, data);
    case TaskName.Hangup:
      const TaskHangup = require('./hangup');
      return new TaskHangup(logger, data);
    case TaskName.Say:
      const TaskSay = require('./say');
      return new TaskSay(logger, data);
    case TaskName.Gather:
      const TaskGather = require('./gather');
      return new TaskGather(logger, data);
  }

  // should never reach
  throw new Error(`invalid task ${name} (please update specs.json and make_task.js)`);
}

module.exports = makeTask;
