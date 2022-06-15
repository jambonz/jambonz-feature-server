const Task = require('./task');
const {TaskName} = require('../utils/constants');
const errBadInstruction = new Error('malformed jambonz application payload');

function makeTask(logger, obj, parent) {
  const keys = Object.keys(obj);
  if (!keys || keys.length !== 1) {
    throw errBadInstruction;
  }
  const name = keys[0];
  const data = obj[name];
  if (typeof data !== 'object') {
    throw errBadInstruction;
  }
  Task.validate(name, data);
  switch (name) {
    case TaskName.SipDecline:
      const TaskSipDecline = require('./sip_decline');
      return new TaskSipDecline(logger, data, parent);
    case TaskName.SipRequest:
      const TaskSipRequest = require('./sip_request');
      return new TaskSipRequest(logger, data, parent);
    case TaskName.SipRefer:
      const TaskSipRefer = require('./sip_refer');
      return new TaskSipRefer(logger, data, parent);
    case TaskName.Config:
      const TaskConfig = require('./config');
      return new TaskConfig(logger, data, parent);
    case TaskName.Conference:
      const TaskConference = require('./conference');
      return new TaskConference(logger, data, parent);
    case TaskName.Dial:
      const TaskDial = require('./dial');
      return new TaskDial(logger, data, parent);
    case TaskName.Dialogflow:
      const TaskDialogflow = require('./dialogflow');
      return new TaskDialogflow(logger, data, parent);
    case TaskName.Dequeue:
      const TaskDequeue = require('./dequeue');
      return new TaskDequeue(logger, data, parent);
    case TaskName.Dtmf:
      const TaskDtmf = require('./dtmf');
      return new TaskDtmf(logger, data, parent);
    case TaskName.Enqueue:
      const TaskEnqueue = require('./enqueue');
      return new TaskEnqueue(logger, data, parent);
    case TaskName.Hangup:
      const TaskHangup = require('./hangup');
      return new TaskHangup(logger, data, parent);
    case TaskName.Leave:
      const TaskLeave = require('./leave');
      return new TaskLeave(logger, data, parent);
    case TaskName.Lex:
      const TaskLex = require('./lex');
      return new TaskLex(logger, data, parent);
    case TaskName.Message:
      const TaskMessage = require('./message');
      return new TaskMessage(logger, data, parent);
    case TaskName.Rasa:
      const TaskRasa = require('./rasa');
      return new TaskRasa(logger, data, parent);
    case TaskName.Say:
      const TaskSay = require('./say');
      return new TaskSay(logger, data, parent);
    case TaskName.Play:
      const TaskPlay = require('./play');
      return new TaskPlay(logger, data, parent);
    case TaskName.Pause:
      const TaskPause = require('./pause');
      return new TaskPause(logger, data, parent);
    case TaskName.Gather:
      const TaskGather = require('./gather');
      return new TaskGather(logger, data, parent);
    case TaskName.Transcribe:
      const TaskTranscribe = require('./transcribe');
      return new TaskTranscribe(logger, data, parent);
    case TaskName.Listen:
      const TaskListen = require('./listen');
      return new TaskListen(logger, data, parent);
    case TaskName.Redirect:
      const TaskRedirect = require('./redirect');
      return new TaskRedirect(logger, data, parent);
    case TaskName.RestDial:
      const TaskRestDial = require('./rest_dial');
      return new TaskRestDial(logger, data, parent);
    case TaskName.Tag:
      const TaskTag = require('./tag');
      return new TaskTag(logger, data, parent);
  }

  // should never reach
  throw new Error(`invalid jambonz verb '${name}'`);
}

module.exports = makeTask;
