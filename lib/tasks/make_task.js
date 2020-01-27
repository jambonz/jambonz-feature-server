const Task = require('./task');
const {TaskName} = require('../utils/constants');
const errBadInstruction = new Error('invalid instruction payload');

function makeTask(logger, obj) {
  const keys = Object.keys(obj);
  if (!keys || keys.length !== 1) {
    throw errBadInstruction;
  }
  const name = keys[0];
  const data = obj[name];
  logger.debug(data, `makeTask: ${name}`);
  if (typeof data !== 'object') {
    throw errBadInstruction;
  }
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
    case TaskName.Play:
      const TaskPlay = require('./play');
      return new TaskPlay(logger, data);
    case TaskName.Gather:
      const TaskGather = require('./gather');
      return new TaskGather(logger, data);
    case TaskName.Transcribe:
      const TaskTranscribe = require('./transcribe');
      return new TaskTranscribe(logger, data);
    case TaskName.Listen:
      const TaskListen = require('./listen');
      return new TaskListen(logger, data);
    case TaskName.Redirect:
      const TaskRedirect = require('./redirect');
      return new TaskRedirect(logger, data);
  }

  // should never reach
  throw new Error(`invalid task ${name} (please update specs.json and make_task.js)`);
}

module.exports = makeTask;
