const Task = require('../task');
const {TaskPreconditions} = require('../../utils/constants');
const TaskLlmOpenAI_S2S = require('./llms/openai_s2s');
const TaskLlmVoiceAgent_S2S = require('./llms/voice_agent_s2s');
const TaskLlmUltravox_S2S = require('./llms/ultravox_s2s');
const TaskLlmElevenlabs_S2S = require('./llms/elevenlabs_s2s');
const TaskLlmGoogle_S2S = require('./llms/google_s2s');

class TaskLlm extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    ['vendor', 'model', 'auth', 'connectOptions'].forEach((prop) => {
      this[prop] = this.data[prop];
    });

    this.eventHandlers = [];

    // delegate to the specific llm model
    this.llm = this.createSpecificLlm();
  }

  get name() { return this.llm.name ; }

  get toolHook() { return this.llm?.toolHook; }

  get eventHook() { return this.llm?.eventHook; }

  get ep() { return this.cs.ep; }

  async exec(cs, {ep}) {
    await super.exec(cs, {ep});
    await this.llm.exec(cs, {ep});
  }

  async kill(cs) {
    super.kill(cs);
    await this.llm.kill(cs);
  }

  createSpecificLlm() {
    let llm;
    switch (this.vendor) {
      case 'openai':
      case 'microsoft':
        llm = new TaskLlmOpenAI_S2S(this.logger, this.data, this);
        break;

      case 'voiceagent':
      case 'deepgram':
        llm = new TaskLlmVoiceAgent_S2S(this.logger, this.data, this);
        break;

      case 'ultravox':
        llm = new TaskLlmUltravox_S2S(this.logger, this.data, this);
        break;

      case 'elevenlabs':
        llm = new TaskLlmElevenlabs_S2S(this.logger, this.data, this);
        break;

      case 'google':
        llm = new TaskLlmGoogle_S2S(this.logger, this.data, this);
        break;

      default:
        throw new Error(`Unsupported vendor ${this.vendor} for LLM`);
    }

    if (!llm) {
      throw new Error(`Unsupported vendor:model ${this.vendor}:${this.model}`);
    }
    return llm;
  }

  addCustomEventListener(ep, event, handler) {
    this.eventHandlers.push({ep, event, handler});
    ep.addCustomEventListener(event, handler);
  }

  removeCustomEventListeners() {
    this.eventHandlers.forEach((h) => h.ep.removeCustomEventListener(h.event, h.handler));
  }

  async sendEventHook(data) {
    await this.cs?.requestor.request('llm:event', this.eventHook, data);
  }

  async sendToolHook(tool_call_id, data) {
    await this.cs?.requestor.request('llm:tool-call', this.toolHook, {tool_call_id, ...data});
  }

  async processToolOutput(tool_call_id, data) {
    if (!this.ep.connected) {
      this.logger.info('TaskLlm:processToolOutput - no connected endpoint');
      return;
    }
    this.llm.processToolOutput(this.ep, tool_call_id, data);
  }

  async processLlmUpdate(data, callSid) {
    if (this.ep.connected) {
      if (typeof this.llm.processLlmUpdate === 'function') {
        this.llm.processLlmUpdate(this.ep, data, callSid);
      }
      else {
        const {vendor, model} = this.llm;
        this.logger.info({data, callSid},
          `TaskLlm:_processLlmUpdate: LLM ${vendor}:${model} does not support llm:update`);
      }
    }
  }
}

module.exports = TaskLlm;
