const Task = require('../../task');
const TaskName = 'Llm_OpenAI_s2s';
const {LlmEvents_OpenAI} = require('../../../utils/constants');
const ClientEvent = 'client.event';
const SessionDelete = 'session.delete';

const openai_server_events = [
  'error',
  'session.created',
  'session.updated',
  'conversation.created',
  'input_audio_buffer.committed',
  'input_audio_buffer.cleared',
  'input_audio_buffer.speech_started',
  'input_audio_buffer.speech_stopped',
  'conversation.item.created',
  'conversation.item.input_audio_transcription.completed',
  'conversation.item.input_audio_transcription.failed',
  'conversation.item.truncated',
  'conversation.item.deleted',
  'response.created',
  'response.done',
  'response.output_item.added',
  'response.output_item.done',
  'response.content_part.added',
  'response.content_part.done',
  'response.text.delta',
  'response.text.done',
  'response.audio_transcript.delta',
  'response.audio_transcript.done',
  'response.audio.delta',
  'response.audio.done',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.done',
  'rate_limits.updated',
  'output_audio.playback_started',
  'output_audio.playback_stopped',
];

const expandWildcards = (events) => {
  const expandedEvents = [];

  events.forEach((evt) => {
    if (evt.endsWith('.*')) {
      const prefix = evt.slice(0, -2); // Remove the wildcard ".*"
      const matchingEvents = openai_server_events.filter((e) => e.startsWith(prefix));
      expandedEvents.push(...matchingEvents);
    } else {
      expandedEvents.push(evt);
    }
  });

  return expandedEvents;
};

class TaskLlmOpenAI_S2S extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    this.parent = parentTask;

    this.vendor = this.parent.vendor;
    this.model = this.parent.model || 'gpt-4o-realtime-preview-2024-12-17';
    this.auth = this.parent.auth;
    this.connectionOptions = this.parent.connectOptions;

    const {apiKey} = this.auth || {};
    if (!apiKey) throw new Error('auth.apiKey is required for OpenAI S2S');

    if (['openai', 'microsoft'].indexOf(this.vendor) === -1) {
      throw new Error(`Invalid vendor ${this.vendor} for OpenAI S2S`);
    }

    if ('microsoft' === this.vendor && !this.connectionOptions?.host) {
      throw new Error('connectionOptions.host is required for Microsoft OpenAI S2S');
    }

    this.apiKey = apiKey;
    this.authType = 'microsoft' === this.vendor ? 'query' : 'bearer';
    this.actionHook = this.data.actionHook;
    this.eventHook = this.data.eventHook;
    this.toolHook = this.data.toolHook;
    const {response_create, session_update} = this.data.llmOptions;

    if (typeof response_create !== 'object') {
      throw new Error('llmOptions with an initial response.create is required for OpenAI S2S');
    }

    this.response_create = response_create;
    this.session_update = session_update;

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
    this._populateEvents(this.data.events || openai_server_events);

    this.addCustomEventListener = parentTask.addCustomEventListener.bind(parentTask);
    this.removeCustomEventListeners = parentTask.removeCustomEventListeners.bind(parentTask);
  }

  get name() { return TaskName; }

  get host() {
    const {host} = this.connectionOptions || {};
    return host || (this.vendor === 'openai' ? 'api.openai.com' : void 0);
  }

  get path() {
    const {path} = this.connectionOptions || {};
    if (path) return path;

    switch (this.vendor) {
      case 'openai':
        return `v1/realtime?model=${this.model}`;
      case 'microsoft':
        return `openai/realtime?api-version=2024-10-01-preview&deployment=${this.model}`;
    }
  }

  async _api(ep, args) {
    const res = await ep.api('uuid_openai_s2s', `^^|${args.join('|')}`);
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
      .catch((err) => this.logger.info({err}, 'TaskLlmOpenAI_S2S:kill - error deleting session'));

    this.notifyTaskDone();
  }

  /**
   * Send function call output to the OpenAI server in the form of conversation.item.create
   * per https://platform.openai.com/docs/guides/realtime/function-calls
   */
  async processToolOutput(ep, tool_call_id, data) {
    try {
      this.logger.debug({tool_call_id, data}, 'TaskLlmOpenAI_S2S:processToolOutput');

      if (!data.type || data.type !== 'conversation.item.create') {
        this.logger.info({data},
          'TaskLlmOpenAI_S2S:processToolOutput - invalid tool output, must be conversation.item.create');
      }
      else {
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(data)]);

        // spec also recommends to send immediate response.create
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify({type: 'response.create'})]);
      }
    } catch (err) {
      this.logger.info({err}, 'TaskLlmOpenAI_S2S:processToolOutput');
    }
  }

  /**
   * Send a session.update to the OpenAI server
   * Note: creating and deleting conversation items also supported as well as interrupting the assistant
   */
  async processLlmUpdate(ep, data, _callSid) {
    try {
      this.logger.debug({data, _callSid}, 'TaskLlmOpenAI_S2S:processLlmUpdate');

      if (!data.type || ![
        'session.update',
        'conversation.item.create',
        'conversation.item.delete',
        'response.cancel'
      ].includes(data.type)) {
        this.logger.info({data}, 'TaskLlmOpenAI_S2S:processLlmUpdate - invalid mid-call request');
      }
      else {
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(data)]);
      }
    } catch (err) {
      this.logger.info({err}, 'TaskLlmOpenAI_S2S:processLlmUpdate');
    }
  }

  async _startListening(cs, ep) {
    this._registerHandlers(ep);

    try {
      const args = [ep.uuid, 'session.create', this.host, this.path, this.authType, this.apiKey];
      await this._api(ep, args);
    } catch (err) {
      this.logger.error({err}, 'TaskLlmOpenAI_S2S:_startListening');
      this.notifyTaskDone();
    }
  }

  async _sendClientEvent(ep, obj) {
    let ok = true;
    this.logger.debug({obj}, 'TaskLlmOpenAI_S2S:_sendClientEvent');
    try {
      const args = [ep.uuid, ClientEvent, JSON.stringify(obj)];
      await this._api(ep, args);
    } catch (err) {
      ok = false;
      this.logger.error({err}, 'TaskLlmOpenAI_S2S:_sendClientEvent - Error');
    }
    return ok;
  }

  async _sendInitialMessage(ep) {
    let obj = {type: 'response.create', response: this.response_create};
    if (!await this._sendClientEvent(ep, obj)) {
      this.notifyTaskDone();
    }

    /* send immediate session.update if present */
    else if (this.session_update) {
      if (this.parent.isMcpEnabled) {
        this.logger.debug('TaskLlmOpenAI_S2S:_sendInitialMessage - mcp enabled');
        const tools = await this.parent.mcpService.getAvailableMcpTools();
        if (tools && tools.length > 0 && this.session_update) {
          const convertedTools = tools.map((tool) => ({
            name: tool.name,
            type: 'function',
            description: tool.description,
            parameters: tool.inputSchema
          }));

          this.session_update.tools = [
            ...convertedTools,
            ...(this.session_update.tools || [])
          ];
        }
      }
      obj = {type: 'session.update', session: this.session_update};
      this.logger.debug({obj}, 'TaskLlmOpenAI_S2S:_sendInitialMessage - sending session.update');
      if (!await this._sendClientEvent(ep, obj)) {
        this.notifyTaskDone();
      }
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
  async _onServerEvent(ep, evt) {
    let endConversation = false;
    const type = evt.type;
    this.logger.info({evt}, 'TaskLlmOpenAI_S2S:_onServerEvent');

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
    else if (type === 'response.output_item.done' && evt.item?.type === 'function_call') {
      this.logger.debug({evt}, 'TaskLlmOpenAI_S2S:_onServerEvent - function_call');
      const {name, call_id} = evt.item;
      const args = JSON.parse(evt.item.arguments);

      const mcpTools = this.parent.isMcpEnabled ? await this.parent.mcpService.getAvailableMcpTools() : [];
      if (mcpTools.some((tool) => tool.name === name)) {
        this.logger.debug({call_id, name, args}, 'TaskLlmOpenAI_S2S:_onServerEvent - calling mcp tool');
        try {
          const res = await this.parent.mcpService.callMcpTool(name, args);
          this.logger.debug({res}, 'TaskLlmOpenAI_S2S:_onServerEvent - function_call - mcp result');
          this.processToolOutput(ep, call_id, {
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id,
              output: res.content[0]?.text || 'There is no output from the function call',
            }
          });
          return;
        } catch (err) {
          this.logger.info({err, evt}, 'TaskLlmOpenAI_S2S - error calling function');
          this.results = {
            completionReason: 'client error calling mcp function',
            error: err
          };
          endConversation = true;
        }
      }
      else if (!this.toolHook) {
        this.logger.warn({evt}, 'TaskLlmOpenAI_S2S:_onServerEvent - no toolHook defined!');
      }
      else {
        try {
          await this.parent.sendToolHook(call_id, {name, args});
        } catch (err) {
          this.logger.info({err, evt}, 'TaskLlmOpenAI - error calling function');
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
        .catch((err) => this.logger.info({err}, 'TaskLlmOpenAI_S2S:_onServerEvent - error sending event hook'));
    }

    if (endConversation) {
      this.logger.info({results: this.results}, 'TaskLlmOpenAI_S2S:_onServerEvent - ending conversation due to error');
      this.notifyTaskDone();
    }
  }

  _populateEvents(events) {
    if (events.includes('all')) {
      /* work by excluding specific events */
      const exclude = events
        .filter((evt) => evt.startsWith('-'))
        .map((evt) => evt.slice(1));
      if (exclude.length === 0) this.includeEvents = openai_server_events;
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
    }, 'TaskLlmOpenAI_S2S:_populateEvents');
  }
}

module.exports = TaskLlmOpenAI_S2S;
