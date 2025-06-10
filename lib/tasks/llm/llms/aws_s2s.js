const Task = require('../../task');
const crypto = require('crypto');
const TaskName = 'Llm_Aws_s2s';
const {LlmEvents_Aws} = require('../../../utils/constants');
const ClientEvent = 'client.event';
const SessionDelete = 'session.delete';

const aws_server_events = [
  'error',
  'session.created',
  'session.updated',
];

const expandWildcards = (events) => {
  const expandedEvents = [];

  events.forEach((evt) => {
    if (evt.endsWith('.*')) {
      const prefix = evt.slice(0, -2); // Remove the wildcard ".*"
      const matchingEvents = aws_server_events.filter((e) => e.startsWith(prefix));
      expandedEvents.push(...matchingEvents);
    } else {
      expandedEvents.push(evt);
    }
  });

  return expandedEvents;
};

class TaskLlmAws_S2S extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    this.parent = parentTask;

    this.vendor = this.parent.vendor;
    this.model = this.parent.model;
    this.auth = this.parent.auth;
    this.connectionOptions = this.parent.connectOptions;

    const {access_key_id, secret_access_key, aws_region} = this.auth || {};
    if (!access_key_id) throw new Error('auth.access_key_id is required for Aws S2S');
    if (!secret_access_key) throw new Error('auth.secret_access_key is required for Aws S2S');
    if (!aws_region) throw new Error('auth.aws_region is required for Aws S2S');

    this.access_key_id = access_key_id;
    this.secret_access_key = secret_access_key;
    this.aws_region = aws_region;
    this.actionHook = this.data.actionHook;
    this.eventHook = this.data.eventHook;
    this.toolHook = this.data.toolHook;
    const {inferenceConfiguration, toolConfiguration, voiceId, systemPrompt} = this.data.llmOptions;

    this.inferenceConfiguration = inferenceConfiguration;
    this.toolConfiguration = toolConfiguration;
    this.voiceId = voiceId;
    this.systemPrompt = systemPrompt;
    this.promptName = crypto.randomUUID();

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
    this._populateEvents(this.data.events || aws_server_events);

    this.addCustomEventListener = parentTask.addCustomEventListener.bind(parentTask);
    this.removeCustomEventListeners = parentTask.removeCustomEventListeners.bind(parentTask);
  }

  get name() { return TaskName; }

  get host() {
    const {host} = this.connectionOptions || {};
    return host || (this.vendor === 'aws' ? 'api.aws.com' : void 0);
  }

  get path() {
    const {path} = this.connectionOptions || {};
    if (path) return path;

    switch (this.vendor) {
      case 'aws':
        return `v1/realtime?model=${this.model}`;
      case 'microsoft':
        return `aws/realtime?api-version=2024-10-01-preview&deployment=${this.model}`;
    }
  }

  async _api(ep, args) {
    const res = await ep.api('uuid_aws_s2s', `^^|${args.join('|')}`);
    if (!res.body?.startsWith('+OK')) {
      throw new Error({args}, `Error calling uuid_aws_s2s: ${res.body}`);
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
      .catch((err) => this.logger.info({err}, 'TaskLlmAws_S2S:kill - error deleting session'));

    this.notifyTaskDone();
  }

  /**
   * Send function call output to the Aws server in the form of conversation.item.create
   * per https://platform.aws.com/docs/guides/realtime/function-calls
   */
  async processToolOutput(ep, tool_call_id, data) {
    try {
      this.logger.debug({tool_call_id, data}, 'TaskLlmAws_S2S:processToolOutput');

      if (!data.type || data.type !== 'conversation.item.create') {
        this.logger.info({data},
          'TaskLlmAws_S2S:processToolOutput - invalid tool output, must be conversation.item.create');
      }
      else {
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(data)]);

        // spec also recommends to send immediate response.create
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify({type: 'response.create'})]);
      }
    } catch (err) {
      this.logger.info({err}, 'TaskLlmAws_S2S:processToolOutput');
    }
  }

  /**
   * Send a session.update to the Aws server
   * Note: creating and deleting conversation items also supported as well as interrupting the assistant
   */
  async processLlmUpdate(ep, data, _callSid) {
    try {
      this.logger.debug({data, _callSid}, 'TaskLlmAws_S2S:processLlmUpdate');

      if (!data.type || ![
        'session.update',
        'conversation.item.create',
        'conversation.item.delete',
        'response.cancel'
      ].includes(data.type)) {
        this.logger.info({data}, 'TaskLlmAws_S2S:processLlmUpdate - invalid mid-call request');
      }
      else {
        await this._api(ep, [ep.uuid, ClientEvent, JSON.stringify(data)]);
      }
    } catch (err) {
      this.logger.info({err}, 'TaskLlmAws_S2S:processLlmUpdate');
    }
  }

  async _startListening(cs, ep) {
    this._registerHandlers(ep);

    try {
      const args = [ep.uuid, 'session.create', this.aws_region, this.model, this.access_key_id, this.secret_access_key];
      await this._api(ep, args);
    } catch (err) {
      this.logger.error({err}, 'TaskLlmAws_S2S:_startListening');
      this.notifyTaskDone();
    }
  }

  async _sendClientEvent(ep, obj) {
    let ok = true;
    this.logger.debug({obj}, 'TaskLlmAws_S2S:_sendClientEvent');
    try {
      const args = [ep.uuid, ClientEvent, JSON.stringify(obj)];
      await this._api(ep, args);
    } catch (err) {
      ok = false;
      this.logger.error({err}, 'TaskLlmAws_S2S:_sendClientEvent - Error');
    }
    return ok;
  }

  async _sendInitialMessage(ep) {
    const settionStart = {
      event: {
        sessionStart: {
          inferenceConfiguration: this.inferenceConfiguration || {
            maxTokens: 1024,
            temperature: 0.7,
            topP: 0.9,
          },
        }
      }
    };

    if (!await this._sendClientEvent(ep, settionStart)) {
      return this.notifyTaskDone();
    }

    const promptStart = {
      event: {
        promptStart: {
          promptName: this.promptName,
          textOutputConfiguration: {
            mediaType: 'text/plain',
          },
          audioOutputConfiguration: {
            voiceId: this.voiceId || 'tiffany',
          },
          toolUseOutputConfiguration: {
            mediaType: 'application/json',
          },
          ...(this.toolConfiguration && {
            toolConfiguration: this.toolConfiguration
          })
        }
      }
    };
    if (!await this._sendClientEvent(ep, promptStart)) {
      return this.notifyTaskDone();
    }

    if (this.systemPrompt) {
      const contentName = crypto.randomUUID();
      const systemPromptContentStart = {
        event: {
          contentStart: {
            promptName: this.promptName,
            contentName,
            type: 'TEXT',
            interactive: true,
            role: 'SYSTEM',
            textInputConfiguration: {
              mediaType: 'text/plain',
            }
          }
        }
      };
      if (!await this._sendClientEvent(ep, systemPromptContentStart)) {
        return this.notifyTaskDone();
      }

      const systemPromptContent = {
        event: {
          textInput: {
            promptName: this.promptName,
            contentName,
            content: this.systemPrompt
          }
        }
      };

      if (!await this._sendClientEvent(ep, systemPromptContent)) {
        return this.notifyTaskDone();
      }

      const systemPromptContentEnd = {
        event: {
          contentEnd: {
            promptName: this.promptName,
            contentName,
          }
        }
      };
      if (!await this._sendClientEvent(ep, systemPromptContentEnd)) {
        return this.notifyTaskDone();
      }
    }

    const audioContentStart = {
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName: crypto.randomUUID(),
          type: 'AUDIO',
          interactive: true,
          role: 'USER',
        }
      }
    };
    if (!await this._sendClientEvent(ep, audioContentStart)) {
      return this.notifyTaskDone();
    }

  }

  _registerHandlers(ep) {
    this.addCustomEventListener(ep, LlmEvents_Aws.Connect, this._onConnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Aws.ConnectFailure, this._onConnectFailure.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Aws.Disconnect, this._onDisconnect.bind(this, ep));
    this.addCustomEventListener(ep, LlmEvents_Aws.ServerEvent, this._onServerEvent.bind(this, ep));
  }

  _unregisterHandlers() {
    this.removeCustomEventListeners();
  }

  _onError(ep, evt) {
    this.logger.info({evt}, 'TaskLlmAws_S2S:_onError');
    this.notifyTaskDone();
  }

  _onConnect(ep) {
    this.logger.debug('TaskLlmAws_S2S:_onConnect');
    this._sendInitialMessage(ep);
  }
  _onConnectFailure(_ep, evt) {
    this.logger.info(evt, 'TaskLlmAws_S2S:_onConnectFailure');
    this.results = {completionReason: 'connection failure'};
    this.notifyTaskDone();
  }
  _onDisconnect(_ep, evt) {
    this.logger.info(evt, 'TaskLlmAws_S2S:_onConnectFailure');
    this.results = {completionReason: 'disconnect from remote end'};
    this.notifyTaskDone();
  }
  async _onServerEvent(ep, evt) {
    let endConversation = false;
    const type = evt.type;
    this.logger.info({evt}, 'TaskLlmAws_S2S:_onServerEvent');

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
      this.logger.debug({evt}, 'TaskLlmAws_S2S:_onServerEvent - function_call');
      const {name, call_id} = evt.item;
      const args = JSON.parse(evt.item.arguments);

      const mcpTools = this.parent.isMcpEnabled ? await this.parent.mcpService.getAvailableMcpTools() : [];
      if (mcpTools.some((tool) => tool.name === name)) {
        this.logger.debug({call_id, name, args}, 'TaskLlmAws_S2S:_onServerEvent - calling mcp tool');
        try {
          const res = await this.parent.mcpService.callMcpTool(name, args);
          this.logger.debug({res}, 'TaskLlmAws_S2S:_onServerEvent - function_call - mcp result');
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
          this.logger.info({err, evt}, 'TaskLlmAws_S2S - error calling function');
          this.results = {
            completionReason: 'client error calling mcp function',
            error: err
          };
          endConversation = true;
        }
      }
      else if (!this.toolHook) {
        this.logger.warn({evt}, 'TaskLlmAws_S2S:_onServerEvent - no toolHook defined!');
      }
      else {
        try {
          await this.parent.sendToolHook(call_id, {name, args});
        } catch (err) {
          this.logger.info({err, evt}, 'TaskLlmAws - error calling function');
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
        .catch((err) => this.logger.info({err}, 'TaskLlmAws_S2S:_onServerEvent - error sending event hook'));
    }

    if (endConversation) {
      this.logger.info({results: this.results}, 'TaskLlmAws_S2S:_onServerEvent - ending conversation due to error');
      this.notifyTaskDone();
    }
  }

  _populateEvents(events) {
    if (events.includes('all')) {
      /* work by excluding specific events */
      const exclude = events
        .filter((evt) => evt.startsWith('-'))
        .map((evt) => evt.slice(1));
      if (exclude.length === 0) this.includeEvents = aws_server_events;
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
    }, 'TaskLlmAws_S2S:_populateEvents');
  }
}

module.exports = TaskLlmAws_S2S;
