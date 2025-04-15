const Task = require('../task');
const {TaskPreconditions} = require('../../utils/constants');
const TaskLlmOpenAI_S2S = require('./llms/openai_s2s');
const TaskLlmVoiceAgent_S2S = require('./llms/voice_agent_s2s');
const TaskLlmUltravox_S2S = require('./llms/ultravox_s2s');
const TaskLlmElevenlabs_S2S = require('./llms/elevenlabs_s2s');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');

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
    // MCP
    this.mcpServers = this.data.mcpServers || [];
    this.mcpClients = [];
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

  async _getMcpClients() {
    if (this.mcpClients.length > 0) {
      return this.mcpClients;
    }
    const SSEClientTransport = (await import('@modelcontextprotocol/sdk/client/sse.js')).SSEClientTransport;
    for (const server of this.mcpServers) {
      const {url} = server;
      if (url) {
        try {
          const transport = new SSEClientTransport(new URL(url), {});
          const client = new Client({ name: 'Jambonz MCP Client', version: '1.0.0'});
          await client.connect(transport);
          // collect available tools
          const tools = await client.listTools();
          this.mcpClients.push({
            url,
            client,
            tools: tools || [],
          });
          this.logger.debug({url, tools}, 'TaskLlm:getMcpClient - mcp client created');
        } catch (err) {
          this.logger.error({err}, 'TaskLlm:getMcpClient - error creating mcp client');
          throw err;
        }
      }
    }
  }

  async findMcpClientByToolName(name) {
    if (this.mcpClients.length === 0) {
      await this._getMcpClients();
    }
    for (const mcpClient of this.mcpClients) {
      const {tools} = mcpClient;
      if (tools && tools.some((tool) => tool.name === name)) {
        return mcpClient.client;
      }
    }
    return null;
  }

  getAvailableMcpTools() {
    // returns a list of available tools from all MCP clients
    const tools = [];
    for (const mcpClient of this.mcpClients) {
      const {tools: availableTools} = mcpClient;
      if (availableTools) {
        tools.push(...availableTools);
      }
    }
    return tools;
  }

  /**
   * Calls a tool through the Model Context Protocol (MCP) with specified parameters
   *
   * This method invokes a named tool available through the MCP server and passes
   * the provided input parameters. The tool executes remotely and returns results
   * in a standardized format.
   *
   * @param {string} name - The name of the tool to call (must match a tool available through MCP)
   * @param {Object} input - The input parameters to pass to the tool as arguments
   *
   * @returns {Promise<Object>} The result from the tool execution, typically containing:
   *   - content {Array} Array of content items returned by the tool
   *     - Each item typically has:
   *       - type {string} The type of content (e.g., "text", "image")
   *       - text {string} The text content when type is "text"
   * @throws {Error} If tool execution fails or if the MCP server connection fails
   */

  async callMcpTool(name, input) {
    const client = await this.findMcpClientByToolName(name);
    if (client) {
      try {
        const result = await client.callTool({
          name,
          arguments: input,
        });
        this.logger.debug({result}, 'TaskLlm:callMcpTool - result');
        return result;
      } catch (err) {
        this.logger.error({err}, 'TaskLlm:callMcpTool - error calling tool');
        throw err;
      }
    }
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
