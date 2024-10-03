const Task = require('../../task');
const TaskName = 'Llm_OpenAI_s2s';
const {LlmEvents_OpenAI} = require('../../../utils/constants');
const ClientEvent = 'client.event';

class TaskLlmOpenAI_S2S extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    this.parent = parentTask;

    const {apiKey} = this.data.auth || {};
    if (!apiKey) throw new Error('auth.apiKey is required for OpenAI S2S');

    this.apiKey = apiKey;
    this.actionHook = this.data.actionHook;
    this.eventHook = this.data.eventHook;
    this.options = this.data.llmOptions;
    if (!this.options || typeof this.options !== 'object') {
      throw new Error('llmOptions with an initial response.create is required for OpenAI S2S');
    }

    this.results = {
      completionReason: 'normal conversation end'
    };

    this.addCustomEventListener = parentTask.addCustomEventListener.bind(parentTask);
    this.removeCustomEventListeners = parentTask.removeCustomEventListeners.bind(parentTask);
  }

  get name() { return TaskName; }

  async exec(cs, {ep}) {
    await super.exec(cs);

    await this._startListening(cs, ep);

    await this.awaitTaskDone();

    /* note: the parent llm verb started the span, which is why this is necessary */
    await this.parent.performAction(this.results);

    this._unregisterHandlers();
  }

  async kill(cs) {
    super.kill(cs);
    this.notifyTaskDone();
  }

  async _startListening(cs, ep) {
    this._registerHandlers(ep);

    try {
      const args = [ep.uuid, 'session.create', this.apiKey];
      const evt = await ep.api('uuid_openai_s2s', `^^|${args.join('|')}`);
      this.logger.debug({evt}, 'TaskLlmOpenAI_S2S:_startListening - response from session.create');
    } catch (err) {
      this.logger.error({err}, 'TaskLlmOpenAI_S2S:_startListening');
      this.notifyTaskDone();
    }
  }

  async _sendInitialMessage(ep) {
    const obj = {type: 'response.create', response: this.options};
    try {
      const args = [ep.uuid, ClientEvent, `'${JSON.stringify(obj)}'`];
      const evt = await ep.api('uuid_openai_s2s', `^^|${args.join('|')}`);
      this.logger.debug({evt}, 'TaskLlmOpenAI_S2S:_sendInitialMessage - response from client.event');
    } catch (err) {
      this.logger.error({err}, 'TaskLlmOpenAI_S2S:_sendInitialMessage - Error');
      this.notifyTaskDone();
    }
  }

  _registerHandlers(ep) {
    this.addCustomEventListener(ep, LlmEvents_OpenAI.Connect, this._onConnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_OpenAI.ConnectFailure, this._onConnectFailure.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_OpenAI.Disconnect, this._onDisconnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_OpenAI.ServerEvent, this._onServerEvent.bind(this, ep));
  }

  _unregisterHandlers() {
    this.removeCustomEventListeners();
  }

  _onError(ep, evt) {
    this.logger.info({evt}, 'TaskLlmOpenAI_S2S:_onError');
    this.notifyTaskDone();
  }

  _onConnect(ep) {
    this.logger.debug('TaskLlmOpenAI_S2S:_onConnect');
    this._sendInitialMessage(ep);
  }
  _onConnectFailure(_ep, evt) {
    this.logger.info(evt, 'TaskLlmOpenAI_S2S:_onConnectFailure');
    this.results = {completionReason: 'connection failure'};
    this.notifyTaskDone();
  }
  _onDisconnect(_ep, evt) {
    this.logger.info(evt, 'TaskLlmOpenAI_S2S:_onConnectFailure');
    this.results = {completionReason: 'disconnect from remote end'};
    this.notifyTaskDone();
  }
  _onServerEvent(_ep, evt) {
    this.logger.info({evt}, 'TaskLlmOpenAI_S2S:_onServerEvent');
  }
}

module.exports = TaskLlmOpenAI_S2S;
