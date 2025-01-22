const Task = require('../../task');
const TaskName = 'Llm_Elevenlabs_s2s';
const {LlmEvents_Elevenlabs} = require('../../../utils/constants');
const ClientEvent = 'client.event';
const SessionDelete = 'session.delete';

const elevenlabs_server_events = [
  'conversation_initiation_metadata',
  'user_transcript',
  'agent_response',
  'client_tool_call'
];

const expandWildcards = (events) => {
  const expandedEvents = [];

  events.forEach((evt) => {
    if (evt.endsWith('.*')) {
      const prefix = evt.slice(0, -2); // Remove the wildcard ".*"
      const matchingEvents = elevenlabs_server_events.filter((e) => e.startsWith(prefix));
      expandedEvents.push(...matchingEvents);
    } else {
      expandedEvents.push(evt);
    }
  });

  return expandedEvents;
};

class TaskLlmElevenlabs_S2S extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    this.parent = parentTask;

    this.vendor = this.parent.vendor;

    const {agent_id} = this.auth || {};
    if (!agent_id) throw new Error('auth.agent_id is required for Elevenlabs S2S');

    this.agent_id = agent_id;
    this.actionHook = this.data.actionHook;
    this.eventHook = this.data.eventHook;
    this.toolHook = this.data.toolHook;
    const {conversation_initiation_client_data} = this.data.llmOptions;
    this.conversation_initiation_client_data = conversation_initiation_client_data;
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
    this._populateEvents(this.data.events || elevenlabs_server_events);

    this.addCustomEventListener = parentTask.addCustomEventListener.bind(parentTask);
    this.removeCustomEventListeners = parentTask.removeCustomEventListeners.bind(parentTask);
  }

  get name() { return TaskName; }

  async _api(ep, args) {
    const res = await ep.api('uuid_elevenlabs_s2s', `^^|${args.join('|')}`);
    if (!res.body?.startsWith('+OK')) {
      throw new Error({args}, `Error calling uuid_elevenlabs_s2s: ${res.body}`);
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
      .catch((err) => this.logger.info({err}, 'TaskLlmElevenlabs_S2S:kill - error deleting session'));

    this.notifyTaskDone();
  }

  /**
   * Send function call output to the Elevenlabs server in the form of conversation.item.create
   * per https://platform.elevenlabs.com/docs/guides/realtime/function-calls
   */
  async processToolOutput(ep, tool_call_id, data) {
    try {
      this.logger.debug({tool_call_id, data}, 'TaskLlmElevenlabs_S2S:processToolOutput');

      if (!data.type || data.type !== 'conversation_initiation_client_data') {
        this.logger.info({data},
          'TaskLlmElevenlabs_S2S:processToolOutput - invalid tool output, must be conversation.item.create');
      }
      else {
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(data)]);
      }
    } catch (err) {
      this.logger.info({err}, 'TaskLlmElevenlabs_S2S:processToolOutput');
    }
  }

  /**
   * Send a session.update to the Elevenlabs server
   * Note: creating and deleting conversation items also supported as well as interrupting the assistant
   */
  async processLlmUpdate(ep, data, _callSid) {
    this.logger.debug({data, _callSid}, 'TaskLlmElevenlabs_S2S:processLlmUpdate, ignored');
  }

  async _startListening(cs, ep) {
    this._registerHandlers(ep);

    try {
      const args = [ep.uuid, 'session.create', this.agent_id];
      await this._api(ep, args);
    } catch (err) {
      this.logger.error({err}, 'TaskLlmElevenlabs_S2S:_startListening');
      this.notifyTaskDone();
    }
  }

  async _sendClientEvent(ep, obj) {
    let ok = true;
    this.logger.debug({obj}, 'TaskLlmElevenlabs_S2S:_sendClientEvent');
    try {
      const args = [ep.uuid, ClientEvent, JSON.stringify(obj)];
      await this._api(ep, args);
    } catch (err) {
      ok = false;
      this.logger.error({err}, 'TaskLlmElevenlabs_S2S:_sendClientEvent - Error');
    }
    return ok;
  }

  async _sendInitialMessage(ep) {
    if (this.conversation_initiation_client_data) {
      if (!await this._sendClientEvent(ep, {
        type: 'conversation_initiation_client_data',
        conversation_initiation_client_data: this.conversation_initiation_client_data
      })) {
        this.notifyTaskDone();
      }
    }
  }

  _registerHandlers(ep) {
    this.addCustomEventListener(ep, LlmEvents_Elevenlabs.Connect, this._onConnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Elevenlabs.ConnectFailure, this._onConnectFailure.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Elevenlabs.Disconnect, this._onDisconnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Elevenlabs.ServerEvent, this._onServerEvent.bind(this, ep));
  }

  _unregisterHandlers() {
    this.removeCustomEventListeners();
  }

  _onError(ep, evt) {
    this.logger.info({evt}, 'TaskLlmElevenlabs_S2S:_onError');
    this.notifyTaskDone();
  }

  _onConnect(ep) {
    this.logger.debug('TaskLlmElevenlabs_S2S:_onConnect');
    this._sendInitialMessage(ep);
  }
  _onConnectFailure(_ep, evt) {
    this.logger.info(evt, 'TaskLlmElevenlabs_S2S:_onConnectFailure');
    this.results = {completionReason: 'connection failure'};
    this.notifyTaskDone();
  }
  _onDisconnect(_ep, evt) {
    this.logger.info(evt, 'TaskLlmElevenlabs_S2S:_onConnectFailure');
    this.results = {completionReason: 'disconnect from remote end'};
    this.notifyTaskDone();
  }
  async _onServerEvent(ep, evt) {
    let endConversation = false;
    const type = evt.type;
    this.logger.info({evt}, 'TaskLlmElevenlabs_S2S:_onServerEvent');

    if (type === 'error') {
      endConversation = true;
      this.results = {
        completionReason: 'server error',
        error: evt.error
      };
    }

    /* tool calls */
    else if (type === 'client_tool_call') {
      this.logger.debug({evt}, 'TaskLlmElevenlabs_S2S:_onServerEvent - function_call');
      if (!this.toolHook) {
        this.logger.warn({evt}, 'TaskLlmElevenlabs_S2S:_onServerEvent - no toolHook defined!');
      }
      else {
        const {tool_name: name, tool_call_id: call_id, parameters: args} = evt;

        try {
          await this.parent.sendToolHook(call_id, {name, args});
        } catch (err) {
          this.logger.info({err, evt}, 'TaskLlmElevenlabs_S2S - error calling function');
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
        .catch((err) => this.logger.info({err},
          'TaskLlmElevenlabs_S2S:_onServerEvent - error sending event hook'));
    }

    if (endConversation) {
      this.logger.info({results: this.results},
        'TaskLlmElevenlabs_S2S:_onServerEvent - ending conversation due to error');
      this.notifyTaskDone();
    }
  }

  _populateEvents(events) {
    if (events.includes('all')) {
      /* work by excluding specific events */
      const exclude = events
        .filter((evt) => evt.startsWith('-'))
        .map((evt) => evt.slice(1));
      if (exclude.length === 0) this.includeEvents = elevenlabs_server_events;
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
    }, 'TaskLlmElevenlabs_S2S:_populateEvents');
  }
}

module.exports = TaskLlmElevenlabs_S2S;
