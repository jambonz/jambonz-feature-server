const Task = require('../../task');
const {request} = require('undici');
const {LlmEvents_Ultravox} = require('../../../utils/constants');

const ultravox_server_events = [
  'pong',
  'state',
  'transcript',
  'conversationText',
  'clientToolInvocation',
  'playbackClearBuffer',
];

const ClientEvent = 'client.event';

const expandWildcards = (events) => {
  // no-op for deepgram
  return events;
};

const SessionDelete = 'session.delete';

class TaskLlmUltravox_S2S extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    this.parent = parentTask;

    this.vendor = this.parent.vendor;
    this.model = this.parent.model || 'fixie-ai/ultravox';
    this.auth = this.parent.auth;
    this.connectionOptions = this.parent.connectOptions;

    const {apiKey} = this.auth || {};
    if (!apiKey) throw new Error('auth.apiKey is required for Vendor: Ultravox');
    this.apiKey = apiKey;
    this.actionHook = this.data.actionHook;
    this.eventHook = this.data.eventHook;
    this.toolHook = this.data.toolHook;

    /**
     * only one of these will have items,
     * if includeEvents, then these are the events to include
     * if excludeEvents, then these are the events to exclude
     */
    this.includeEvents = [];
    this.excludeEvents = [];

    /* default to all events if user did not specify */
    this._populateEvents(this.data.events || ultravox_server_events);

    this.addCustomEventListener = parentTask.addCustomEventListener.bind(parentTask);
    this.removeCustomEventListeners = parentTask.removeCustomEventListeners.bind(parentTask);
  }

  async _api(ep, args) {
    const res = await ep.api('uuid_ultravox_s2s', `^^|${args.join('|')}`);
    if (!res.body?.startsWith('+OK')) {
      throw new Error(`Error calling uuid_ultravox_s2s: ${JSON.stringify(res.body)}`);
    }
  }

  async createCall() {
    const payload = {
      ...this.data.llmOptions,
      model: this.model,
      medium: {
        ...(this.data.llmOptions.medium || {}),
        serverWebSocket: {
          inputSampleRate: 8000,
          outputSampleRate: 8000,
        }
      }
    };
    const {statusCode, body} = await request('https://api.ultravox.ai/api/calls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': this.apiKey
      },
      body: JSON.stringify(payload)
    });
    const data = await body.json();
    if (statusCode !== 201 || !data?.joinUrl) {
      this.logger.error({statusCode, data}, 'Ultravox Error registering call');
      throw new Error(`Ultravox  Error registering call: ${data.message}`);
    }
    this.logger.info({joinUrl: data.joinUrl}, 'Ultravox Call registered');
    return data.joinUrl;
  }

  _unregisterHandlers() {
    this.removeCustomEventListeners();
  }

  _registerHandlers(ep) {
    this.addCustomEventListener(ep, LlmEvents_Ultravox.Connect, this._onConnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Ultravox.ConnectFailure, this._onConnectFailure.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Ultravox.Disconnect, this._onDisconnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Ultravox.ServerEvent, this._onServerEvent.bind(this, ep));
  }

  async _startListening(cs, ep) {
    this._registerHandlers(ep);

    const joinUrl = await this.createCall();
    // split the joinUrl into host and path
    const {host, pathname, search} = new URL(joinUrl);

    try {
      const args = [ep.uuid, 'session.create', host, pathname + search];
      await this._api(ep, args);
    } catch (err) {
      this.logger.error({err}, 'TaskLlmUltraVox_S2S:_startListening');
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
      .catch((err) => this.logger.info({err}, 'TaskLlmUltravox_S2S:kill - error deleting session'));

    this.notifyTaskDone();
  }

  _onConnect(ep) {
    this.logger.debug('TaskLlmUltravox_S2S:_onConnect');
  }
  _onConnectFailure(_ep, evt) {
    this.logger.info(evt, 'TaskLlmUltravox_S2S:_onConnectFailure');
    this.results = {completionReason: 'connection failure'};
    this.notifyTaskDone();
  }
  _onDisconnect(_ep, evt) {
    this.logger.info(evt, 'TaskLlmUltravox_S2S:_onConnectFailure');
    this.results = {completionReason: 'disconnect from remote end'};
    this.notifyTaskDone();
  }

  async _onServerEvent(_ep, evt) {
    let endConversation = false;
    const type = evt.type;
    this.logger.info({evt}, 'TaskLlmUltravox_S2S:_onServerEvent');

    /* server errors of some sort */
    if (type === 'error') {
      endConversation = true;
      this.results = {
        completionReason: 'server error',
        error: evt.error
      };
    }

    /* tool calls */
    else if (type === 'client_tool_invocation') {
      this.logger.debug({evt}, 'TaskLlmUltravox_S2S:_onServerEvent - function_call');
      if (!this.toolHook) {
        this.logger.warn({evt}, 'TaskLlmUltravox_S2S:_onServerEvent - no toolHook defined!');
      }
      else {
        const {tool_name: name, invocation_id: call_id} = evt;
        const args = evt.parameters;

        try {
          await this.parent.sendToolHook(call_id, {name, args});
        } catch (err) {
          this.logger.info({err, evt}, 'TaskLlmUltravox_S2S - error calling function');
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
        .catch((err) => this.logger.info({err}, 'TaskLlmUltravox_S2S:_onServerEvent - error sending event hook'));
    }

    if (endConversation) {
      this.logger.info({results: this.results},
        'TaskLlmUltravox_S2S:_onServerEvent - ending conversation due to error');
      this.notifyTaskDone();
    }
  }

  async processToolOutput(ep, tool_call_id, data) {
    try {
      this.logger.debug({tool_call_id, data}, 'TaskLlmUltravox_S2S:processToolOutput');

      if (!data.type || data.type !== 'client_tool_result') {
        this.logger.info({data},
          'TaskLlmUltravox_S2S:processToolOutput - invalid tool output, must be client_tool_result');
      }
      else {
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(data)]);
      }
    } catch (err) {
      this.logger.info({err}, 'TaskLlmUltravox_S2S:processToolOutput');
    }
  }

  _populateEvents(events) {
    if (events.includes('all')) {
      /* work by excluding specific events */
      const exclude = events
        .filter((evt) => evt.startsWith('-'))
        .map((evt) => evt.slice(1));
      if (exclude.length === 0) this.includeEvents = ultravox_server_events;
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
    }, 'TaskLlmUltravox_S2S:_populateEvents');
  }
}

module.exports = TaskLlmUltravox_S2S;
