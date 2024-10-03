const Task = require('../task');
const {TaskPreconditions} = require('../../utils/constants');
const TaskLlmOpenAI_S2S = require('./llms/openai_s2s');

class TaskLlm extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.eventHandlers = [];

    // delegate to the specific llm model
    this.llm = new TaskLlmOpenAI_S2S(logger, opts, this);
  }

  get name() { return this.llm.name ; }

  async exec(cs, {ep}) {
    await super.exec(cs, {ep});
    await this.llm.exec(cs, {ep});
  }

  async kill(cs) {
    super.kill(cs);
    await this.llm.kill(cs);
  }

  addCustomEventListener(ep, event, handler) {
    this.eventHandlers.push({ep, event, handler});
    ep.addCustomEventListener(event, handler);
  }

  removeCustomEventListeners() {
    this.eventHandlers.forEach((h) => h.ep.removeCustomEventListener(h.event, h.handler));
  }

}

module.exports = TaskLlm;
