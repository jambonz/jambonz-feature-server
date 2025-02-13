const Task = require('../../task');
const TaskName = 'Llm_Playht_s2s';
const {LlmEvents_Playht} = require('../../../utils/constants.json');

const playht_server_events = [
  'voiceActivityStart',
  'voiceActivityEnd'
];

const ClientEvent = 'client.event';

const expandWildcards = (events) => {
  // no-op for playht
  return events;
};

const SessionDelete = 'session.delete';

class TaskLlmPlayht_S2S extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    this.parent = parentTask;

    this.vendor = this.parent.vendor;
    this.model = this.parent.model || 'gpt-4o';
    this.auth = this.parent.auth;
    this.connectionOptions = this.parent.connectOptions;

    const {api_key, agent_id} = this.auth || {};
    if (!api_key) throw new Error('auth.api_key is required for Vendor: Playht');
    if (!agent_id) throw new Error('auth.agent_id is required for Vendor: Playht');
    this.api_key = api_key;
    this.actionHook = this.data.actionHook;
    this.eventHook = this.data.eventHook;
    this.llmOptions = this.data.llmOptions || {};

    /**
     * only one of these will have items,
     * if includeEvents, then these are the events to include
     * if excludeEvents, then these are the events to exclude
     */
    this.includeEvents = [];
    this.excludeEvents = [];

    /* default to all events if user did not specify */
    this._populateEvents(this.data.events || playht_server_events);

    this.addCustomEventListener = parentTask.addCustomEventListener.bind(parentTask);
    this.removeCustomEventListeners = parentTask.removeCustomEventListeners.bind(parentTask);
  }

  get name() { return TaskName; }

  async _api(ep, args) {
    const res = await ep.api('uuid_playht_s2s', `^^|${args.join('|')}`);
    if (!res.body?.startsWith('+OK')) {
      throw new Error(`Error calling uuid_playht_s2s: ${JSON.stringify(res.body)}`);
    }
  }

  _unregisterHandlers() {
    this.removeCustomEventListeners();
  }

  _registerHandlers(ep) {
    this.addCustomEventListener(ep, LlmEvents_Playht.Connect, this._onConnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Playht.ConnectFailure, this._onConnectFailure.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Playht.Disconnect, this._onDisconnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Playht.ServerEvent, this._onServerEvent.bind(this, ep));
  }

  async _startListening(cs, ep) {
    this._registerHandlers(ep);

    const host = 'api.play.ai';
    const path = `/v1/talk/${this.agent_id}`;

    try {
      const args = [ep.uuid, 'session.create', host, path];
      await this._api(ep, args);
    } catch (err) {
      this.logger.error({err}, 'TaskLlmPlayht_S2S:_startListening');
      this.notifyTaskDone();
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
      .catch((err) => this.logger.info({err}, 'TaskLlmPlayht_S2S:kill - error deleting session'));

    this.notifyTaskDone();
  }

  _onConnect(ep) {
    this.logger.debug('TaskLlmPlayht_S2S:_onConnect');
    this._sendInitialMessage(ep);
  }
  _onConnectFailure(_ep, evt) {
    this.logger.info(evt, 'TaskLlmPlayht_S2S:_onConnectFailure');
    this.results = {completionReason: 'connection failure'};
    this.notifyTaskDone();
  }
  _onDisconnect(_ep, evt) {
    this.logger.info(evt, 'TaskLlmPlayht_S2S:_onConnectFailure');
    this.results = {completionReason: 'disconnect from remote end'};
    this.notifyTaskDone();
  }

  async _onServerEvent(_ep, evt) {
    let endConversation = false;
    const type = evt.type;
    this.logger.info({evt}, 'TaskLlmPlayht_S2S:_onServerEvent');

    /* server errors of some sort */
    if (type === 'error') {
      endConversation = true;
      this.results = {
        completionReason: 'server error',
        error: evt.message
      };
    }

    /* check whether we should notify on this event */
    if (this.includeEvents.length > 0 ? this.includeEvents.includes(type) : !this.excludeEvents.includes(type)) {
      this.parent.sendEventHook(evt)
        .catch((err) => this.logger.info({err}, 'TaskLlmPlayht_S2S:_onServerEvent - error sending event hook'));
    }

    if (endConversation) {
      this.logger.info({results: this.results},
        'TaskLlmPlayht_S2S:_onServerEvent - ending conversation due to error');
      this.notifyTaskDone();
    }
  }

  async processToolOutput(ep, tool_call_id, data) {
    try {
      this.logger.debug({tool_call_id, data}, 'TaskLlmPlayht_S2S:processToolOutput');

      if (!data.type || data.type !== 'client_tool_result') {
        this.logger.info({data},
          'TaskLlmPlayht_S2S:processToolOutput - invalid tool output, must be client_tool_result');
      }
      else {
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(data)]);
      }
    } catch (err) {
      this.logger.info({err}, 'TaskLlmPlayht_S2S:processToolOutput');
    }
  }

  async _sendInitialMessage(ep) {
    const obj = {
      type: 'setup',
      apiKey: this.api_key,
      ...this.llmOptions
    };
    if (!await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(obj)])) {
      this.notifyTaskDone();
    }
  }

  _populateEvents(events) {
    if (events.includes('all')) {
      /* work by excluding specific events */
      const exclude = events
        .filter((evt) => evt.startsWith('-'))
        .map((evt) => evt.slice(1));
      if (exclude.length === 0) this.includeEvents = playht_server_events;
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
    }, 'TaskLlmPlayht_S2S:_populateEvents');
  }
}

module.exports = TaskLlmPlayht_S2S;
