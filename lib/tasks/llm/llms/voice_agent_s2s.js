const Task = require('../../task');
const TaskName = 'Llm_VoiceAgent_s2s';
const {LlmEvents_VoiceAgent} = require('../../../utils/constants');
const ClientEvent = 'client.event';
const SessionDelete = 'session.delete';

const va_server_events = [
  'Error',
  'Welcome',
  'SettingsApplied',
  'ConversationText',
  'UserStartedSpeaking',
  'EndOfThought',
  'AgentThinking',
  'FunctionCallRequest',
  'FunctionCalling',
  'AgentStartedSpeaking',
  'AgentAudioDone',
];

const expandWildcards = (events) => {
  // no-op for deepgram
  return events;
};

class TaskLlmVoiceAgent_S2S extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    this.parent = parentTask;

    this.vendor = this.parent.vendor;
    this.model = this.parent.model || 'voice-agent';
    this.auth = this.parent.auth;
    this.connectionOptions = this.parent.connectOptions;

    const {apiKey} = this.auth || {};
    if (!apiKey) throw new Error('auth.apiKey is required for VoiceAgent S2S');

    this.apiKey = apiKey;
    this.authType = 'bearer';
    this.actionHook = this.data.actionHook;
    this.eventHook = this.data.eventHook;
    this.toolHook = this.data.toolHook;
    const {Settings} = this.data.llmOptions;

    if (typeof Settings !== 'object') {
      throw new Error('llmOptions with an initial Settings is required for VoiceAgent S2S');
    }

    // eslint-disable-next-line no-unused-vars
    const {audio, ...rest} = Settings;
    const cfg = this.Settings = rest;

    if (!cfg.agent) throw new Error('llmOptions.Settings.agent is required for VoiceAgent S2S');
    if (!cfg.agent.think) {
      throw new Error('llmOptions.Settings.agent.think is required for VoiceAgent S2S');
    }
    if (!cfg.agent.think.provider?.model) {
      throw new Error('llmOptions.Settings.agent.think.provider.model is required for VoiceAgent S2S');
    }
    if (!cfg.agent.think.provider?.type) {
      throw new Error('llmOptions.Settings.agent.think.provider.type is required for VoiceAgent S2S');
    }

    this.results = {
      completionReason: 'normal conversation end'
    };

    /**
     * only one of these will have items,
     * if includeEvents, then these are the events to include
     * if excludeEvents, then these are the events to exclude
     */
    this.includeEvents = [];
    this.excludeEvents = [];

    /* default to all events if user did not specify */
    this._populateEvents(this.data.events || va_server_events);

    this.addCustomEventListener = parentTask.addCustomEventListener.bind(parentTask);
    this.removeCustomEventListeners = parentTask.removeCustomEventListeners.bind(parentTask);
  }

  get name() { return TaskName; }

  get host() {
    const {host} = this.connectionOptions || {};
    return host || 'agent.deepgram.com';
  }

  get path() {
    const {path} = this.connectionOptions || {};
    if (path) return path;

    return '/v1/agent/converse';
  }

  async _api(ep, args) {
    const res = await ep.api('uuid_voice_agent_s2s', `^^|${args.join('|')}`);
    if (!res.body?.startsWith('+OK')) {
      throw new Error(`Error calling uuid_voice_agent_s2s: ${JSON.stringify(res.body)}`);
    }
  }

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

    this._api(cs.ep, [cs.ep.uuid, SessionDelete])
      .catch((err) => this.logger.info({err}, 'TaskLlmVoiceAgent_S2S:kill - error deleting session'));

    this.notifyTaskDone();
  }

  /**
   * Send function call response to the VoiceAgent server
   */
  async processToolOutput(ep, tool_call_id, data) {
    try {
      const {data:response} = data;
      this.logger.debug({tool_call_id, response}, 'TaskLlmVoiceAgent_S2S:processToolOutput');

      if (!response.type || response.type !== 'FunctionCallResponse') {
        this.logger.info({response},
          'TaskLlmVoiceAgent_S2S:processToolOutput - invalid tool output, must be FunctionCallResponse');
      }
      else {
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(response)]);
      }
    } catch (err) {
      this.logger.info({err}, 'TaskLlmVoiceAgent_S2S:processToolOutput');
    }
  }

  /**
   * Send a session.update to the VoiceAgent server
   * Note: creating and deleting conversation items also supported as well as interrupting the assistant
   */
  async processLlmUpdate(ep, data, _callSid) {
    try {
      this.logger.debug({data, _callSid}, 'TaskLlmVoiceAgent_S2S:processLlmUpdate');

      if (!data.type || ![
        'UpdateInstructions',
        'UpdateSpeak',
        'InjectAgentMessage',
      ].includes(data.type)) {
        this.logger.info({data}, 'TaskLlmVoiceAgent_S2S:processLlmUpdate - invalid mid-call request');
      }
      else {
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(data)]);
      }
    } catch (err) {
      this.logger.info({err}, 'TaskLlmVoiceAgent_S2S:processLlmUpdate');
    }
  }

  async _startListening(cs, ep) {
    this._registerHandlers(ep);

    try {
      const args = [ep.uuid, 'session.create', this.host, this.path, this.authType, this.apiKey];
      await this._api(ep, args);
    } catch (err) {
      this.logger.error({err}, `TaskLlmVoiceAgent_S2S:_startListening: ${JSON.stringify(err)}`);
      this.notifyTaskDone();
    }
  }

  async _sendClientEvent(ep, obj) {
    let ok = true;
    this.logger.debug({obj}, 'TaskLlmVoiceAgent_S2S:_sendClientEvent');
    try {
      const args = [ep.uuid, ClientEvent, JSON.stringify(obj)];
      await this._api(ep, args);
    } catch (err) {
      ok = false;
      this.logger.error({err}, 'TaskLlmVoiceAgent_S2S:_sendClientEvent - Error');
    }
    return ok;
  }

  async _sendInitialMessage(ep) {
    const mcpTools = this.parent.isMcpEnabled ? await this.parent.mcpService.getAvailableMcpTools() : [];
    if (mcpTools && mcpTools.length > 0 && this.Settings.agent?.think) {
      const convertedTools = mcpTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }));

      this.Settings.agent.think.functions = [
        ...convertedTools,
        ...(this.Settings.agent.think?.functions || [])
      ];
    }
    if (!await this._sendClientEvent(ep, this.Settings)) {
      this.notifyTaskDone();
    }
  }

  _registerHandlers(ep) {
    this.addCustomEventListener(ep, LlmEvents_VoiceAgent.Connect, this._onConnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_VoiceAgent.ConnectFailure, this._onConnectFailure.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_VoiceAgent.Disconnect, this._onDisconnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_VoiceAgent.ServerEvent, this._onServerEvent.bind(this, ep));
  }

  _unregisterHandlers() {
    this.removeCustomEventListeners();
  }

  _onError(_ep, evt) {
    this.logger.info({evt}, 'TaskLlmVoiceAgent_S2S:_onError');
    this.notifyTaskDone();
  }

  _onConnect(ep) {
    this.logger.debug('TaskLlmVoiceAgent_S2S:_onConnect');
    this._sendInitialMessage(ep);
  }
  _onConnectFailure(_ep, evt) {
    this.logger.info(evt, 'TaskLlmVoiceAgent_S2S:_onConnectFailure');
    this.results = {completionReason: 'connection failure'};
    this.notifyTaskDone();
  }
  _onDisconnect(_ep, evt) {
    this.logger.info(evt, 'TaskLlmVoiceAgent_S2S:_onConnectFailure');
    this.results = {completionReason: 'disconnect from remote end'};
    this.notifyTaskDone();
  }
  async _onServerEvent(_ep, evt) {
    let endConversation = false;
    const type = evt.type;
    this.logger.info({evt}, 'TaskLlmVoiceAgent_S2S:_onServerEvent');

    /* check for failures, such as rate limit exceeded, that should terminate the conversation */
    if (type === 'response.done' && evt.response.status === 'failed') {
      endConversation = true;
      this.results = {
        completionReason: 'server failure',
        error: evt.response.status_details?.error
      };
    }

    /* server errors of some sort */
    else if (type === 'error') {
      endConversation = true;
      this.results = {
        completionReason: 'server error',
        error: evt.error
      };
    }

    /* tool calls */
    else if (type === 'FunctionCallRequest') {
      this.logger.debug({evt}, 'TaskLlmVoiceAgent_S2S:_onServerEvent - function_call');

      const mcpTools = this.parent.isMcpEnabled ? await this.parent.mcpService.getAvailableMcpTools() : [];
      if (!this.toolHook && mcpTools.length === 0) {
        this.logger.warn({evt}, 'TaskLlmVoiceAgent_S2S:_onServerEvent - no toolHook defined!');
      } else {
        const {functions} = evt;
        const handledFunctions = [];

        try {
          if (mcpTools && mcpTools.length > 0) {
            for (const func of functions) {
              const {name, arguments: args, id} = func;
              const tool = mcpTools.find((tool) => tool.name === name);
              if (tool) {
                handledFunctions.push(name);
                const response = await this.parent.mcpService.callMcpTool(name, JSON.parse(args));
                this.logger.debug({response}, 'TaskLlmVoiceAgent_S2S:_onServerEvent - function_call - mcp result');
                this.processToolOutput(_ep, id, {
                  data: {
                    type: 'FunctionCallResponse',
                    id,
                    name,
                    content: response.length > 0 ? response[0].text : 'There is no output from the function call'
                  }
                });
              }
            }
          }

          for (const func of functions) {
            const {name, arguments: args, id} = func;
            if (!handledFunctions.includes(name)) {
              await this.parent.sendToolHook(id, {name, args: JSON.parse(args)});
            }
          }
        } catch (err) {
          this.logger.info({err, evt}, 'TaskLlmVoiceAgent_S2S:_onServerEvent - error calling function');
          this.results = {
            completionReason: 'client error calling function',
            error: err
          };
          endConversation = true;
        }
      }
    }

    /* check whether we should notify on this event */
    if (this.includeEvents.length > 0 ? this.includeEvents.includes(type) : !this.excludeEvents.includes(type)) {
      this.parent.sendEventHook(evt)
        .catch((err) => this.logger.info({err}, 'TaskLlmVoiceAgent_S2S:_onServerEvent - error sending event hook'));
    }

    if (endConversation) {
      this.logger.info({results: this.results},
        'TaskLlmVoiceAgent_S2S:_onServerEvent - ending conversation due to error');
      this.notifyTaskDone();
    }
  }

  _populateEvents(events) {
    if (events.includes('all')) {
      /* work by excluding specific events */
      const exclude = events
        .filter((evt) => evt.startsWith('-'))
        .map((evt) => evt.slice(1));
      if (exclude.length === 0) this.includeEvents = va_server_events;
      else this.excludeEvents = expandWildcards(exclude);
    }
    else {
      /* work by including specific events */
      const include = events
        .filter((evt) => !evt.startsWith('-'));
      this.includeEvents = expandWildcards(include);
    }

    this.logger.debug({
      includeEvents: this.includeEvents,
      excludeEvents: this.excludeEvents
    }, 'TaskLlmVoiceAgent_S2S:_populateEvents');
  }
}

module.exports = TaskLlmVoiceAgent_S2S;
