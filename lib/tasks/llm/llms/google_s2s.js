const Task = require('../../task');
const TaskName = 'Llm_Google_s2s';
const {LlmEvents_Google} = require('../../../utils/constants');
const ClientEvent = 'client.event';
const SessionDelete = 'session.delete';

const google_server_events = [
  'error',
  'session.created',
  'session.updated',
];

const expandWildcards = (events) => {
  const expandedEvents = [];

  events.forEach((evt) => {
    if (evt.endsWith('.*')) {
      const prefix = evt.slice(0, -2); // Remove the wildcard ".*"
      const matchingEvents = google_server_events.filter((e) => e.startsWith(prefix));
      expandedEvents.push(...matchingEvents);
    } else {
      expandedEvents.push(evt);
    }
  });

  return expandedEvents;
};

class TaskLlmGoogle_S2S extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    this.parent = parentTask;

    this.vendor = this.parent.vendor;
    this.vendor = this.parent.vendor;
    this.model = this.parent.model || 'models/gemini-2.0-flash-live-001';
    this.auth = this.parent.auth;
    this.connectionOptions = this.parent.connectOptions;

    const {apiKey} = this.auth || {};
    if (!apiKey) throw new Error('auth.apiKey is required for Google S2S');

    this.apiKey = apiKey;

    this.actionHook = this.data.actionHook;
    this.eventHook = this.data.eventHook;
    this.toolHook = this.data.toolHook;

    const {setup} = this.data.llmOptions;

    if (typeof setup !== 'object') {
      throw new Error('llmOptions with an initial setup is required for Google S2S');
    }
    this.setup = {
      ...setup,
      model: this.model,
      // make sure output is always audio
      generationConfig: {
        ...(setup.generationConfig || {}),
        responseModalities: 'audio'
      }
    };

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
    this._populateEvents(this.data.events || google_server_events);

    this.addCustomEventListener = parentTask.addCustomEventListener.bind(parentTask);
    this.removeCustomEventListeners = parentTask.removeCustomEventListeners.bind(parentTask);
  }

  get name() { return TaskName; }

  async _api(ep, args) {
    const res = await ep.api('uuid_google_s2s', `^^|${args.join('|')}`);
    if (!res.body?.startsWith('+OK')) {
      throw new Error({args}, `Error calling uuid_openai_s2s: ${res.body}`);
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
      .catch((err) => this.logger.info({err}, 'TaskLlmGoogle_S2S:kill - error deleting session'));

    this.notifyTaskDone();
  }

  _populateEvents(events) {
    if (events.includes('all')) {
      /* work by excluding specific events */
      const exclude = events
        .filter((evt) => evt.startsWith('-'))
        .map((evt) => evt.slice(1));
      if (exclude.length === 0) this.includeEvents = google_server_events;
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
    }, 'TaskLlmGoogle_S2S:_populateEvents');
  }

  async _startListening(cs, ep) {
    this._registerHandlers(ep);

    try {
      const args = [ep.uuid, 'session.create', this.apiKey];
      await this._api(ep, args);
    } catch (err) {
      this.logger.error({err}, 'TaskLlmGoogle_S2S:_startListening');
      this.notifyTaskDone();
    }
  }

  async _sendClientEvent(ep, obj) {
    let ok = true;
    this.logger.debug({obj}, 'TaskLlmGoogle_S2S:_sendClientEvent');
    try {
      const args = [ep.uuid, ClientEvent, JSON.stringify(obj)];
      await this._api(ep, args);
    } catch (err) {
      ok = false;
      this.logger.error({err}, 'TaskLlmGoogle_S2S:_sendClientEvent - Error');
    }
    return ok;
  }

  async _sendInitialMessage(ep) {
    const setup = this.setup;
    const mcpTools = this.parent.isMcpEnabled ? await this.parent.mcpService.getAvailableMcpTools() : [];
    if (mcpTools && mcpTools.length > 0) {
      const convertedTools = [
        {
          functionDeclarations: mcpTools.map((tool) => {
            if (tool.inputSchema) {
              delete tool.inputSchema.additionalProperties;
              delete tool.inputSchema['$schema'];
            }
            return {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            };
          })
        }
      ];
      // merge with any existing tools
      setup.tools = [...convertedTools, ...(this.setup.tools || [])];
    }
    if (!await this._sendClientEvent(ep, {
      setup,
    })) {
      this.logger.debug(this.setup, 'TaskLlmGoogle_S2S:_sendInitialMessage - sending session.update');
      this.notifyTaskDone();
    }
  }

  _registerHandlers(ep) {
    this.addCustomEventListener(ep, LlmEvents_Google.Connect, this._onConnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Google.ConnectFailure, this._onConnectFailure.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Google.Disconnect, this._onDisconnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Google.ServerEvent, this._onServerEvent.bind(this, ep));
  }

  _unregisterHandlers() {
    this.removeCustomEventListeners();
  }

  _onError(ep, evt) {
    this.logger.info({evt}, 'TaskLlmGoogle_S2S:_onError');
    this.notifyTaskDone();
  }

  _onConnect(ep) {
    this.logger.debug('TaskLlmGoogle_S2S:_onConnect');
    this._sendInitialMessage(ep);
  }
  _onConnectFailure(_ep, evt) {
    this.logger.info(evt, 'TaskLlmGoogle_S2S:_onConnectFailure');
    this.results = {completionReason: 'connection failure'};
    this.notifyTaskDone();
  }
  _onDisconnect(_ep, evt) {
    this.logger.info(evt, 'TaskLlmGoogle_S2S:_onConnectFailure');
    this.results = {completionReason: 'disconnect from remote end'};
    this.notifyTaskDone();
  }

  async _onServerEvent(ep, evt) {
    let endConversation = false;
    this.logger.debug({evt}, 'TaskLlmGoogle_S2S:_onServerEvent');
    const {toolCall /**toolCallCancellation*/}  = evt;

    if (toolCall) {
      this.logger.debug({toolCall}, 'TaskLlmGoogle_S2S:_onServerEvent - toolCall');
      if (!this.toolHook) {
        this.logger.info({evt}, 'TaskLlmGoogle_S2S:_onServerEvent - no toolHook defined!');
      }
      else {
        const {functionCalls} = toolCall;
        const mcpTools = this.parent.isMcpEnabled ? await this.parent.mcpService.getAvailableMcpTools() : [];
        const functionResponses = [];
        if (mcpTools && mcpTools.length > 0) {
          for (const functionCall of functionCalls) {
            const {name, args, id} = functionCall;
            const tool = mcpTools.find((tool) => tool.name === name);
            if (tool) {
              const response = await this.parent.mcpService.callMcpTool(name, args);
              functionResponses.push({
                response: {
                  output: response,
                },
                id
              });
            }
          }
        }

        if (functionResponses && functionResponses.length > 0) {
          this.logger.debug({functionResponses}, 'TaskLlmGoogle_S2S:_onServerEvent - function_call - mcp result');
          this.processToolOutput(ep, 'tool_call_id', {
            toolResponse: {
              functionResponses
            }
          });
        } else {
          try {
            await this.parent.sendToolHook('function_call_id', {type: 'toolCall', functionCalls});
          } catch (err) {
            this.logger.info({err, evt}, 'TaskLlmGoogle_S2S - error calling function');
            this.results = {
              completionReason: 'client error calling function',
              error: err
            };
            endConversation = true;
          }
        }
      }
    }

    this._sendLlmEvent('llm_event', evt);

    if (endConversation) {
      this.logger.info({results: this.results},
        'TaskLlmGoogle_S2S:_onServerEvent - ending conversation due to error');
      this.notifyTaskDone();
    }
  }

  _sendLlmEvent(type, evt) {
    /* check whether we should notify on this event */
    if (this.includeEvents.length > 0 ? this.includeEvents.includes(type) : !this.excludeEvents.includes(type)) {
      this.parent.sendEventHook(evt)
        .catch((err) => this.logger.info({err}, 'TaskLlmGoogle_S2S:_onServerEvent - error sending event hook'));
    }
  }

  async processLlmUpdate(ep, data, _callSid) {
    try {
      this.logger.debug({data, _callSid}, 'TaskLlmGoogle_S2S:processLlmUpdate');

      await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(data)]);
    } catch (err) {
      this.logger.info({err, data}, 'TaskLlmGoogle_S2S:processLlmUpdate - Error processing LLM update');
    }
  }

  async processToolOutput(ep, tool_call_id, data) {
    try {
      this.logger.debug({tool_call_id, data}, 'TaskLlmGoogle_S2S:processToolOutput');
      const {toolResponse} = data;

      if (!toolResponse) {
        this.logger.info({data},
          'TaskLlmGoogle_S2S:processToolOutput - invalid tool output, must be functionResponses');
      }
      else {
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(data)]);
      }
    } catch (err) {
      this.logger.info({err, data}, 'TaskLlmGoogle_S2S:processToolOutput - Error processing tool output');
    }
  }
}

module.exports = TaskLlmGoogle_S2S;
