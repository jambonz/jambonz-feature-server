const { Client } = require('@modelcontextprotocol/sdk/client/index.js');

class LlmMcpService {

  constructor(logger, mcpServers) {
    this.logger = logger;
    this.mcpServers = mcpServers || [];
    this.mcpClients = [];
  }

  // make sure we call init() before using any of the mcp clients
  // this is to ensure that we have a valid connection to the MCP server
  // and that we have collected the available tools.
  async init() {
    if (this.mcpClients.length > 0) {
      return;
    }
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
    for (const server of this.mcpServers) {
      const { url } = server;
      if (url) {
        try {
          const transport = new SSEClientTransport(new URL(url), {});
          const client = new Client({ name: 'Jambonz MCP Client', version: '1.0.0' });
          await client.connect(transport);
          // collect available tools
          const { tools } = await client.listTools();
          this.mcpClients.push({
            url,
            client,
            tools
          });
        } catch (err) {
          this.logger.error(`LlmMcpService: Failed to connect to MCP server at ${url}: ${err.message}`);
        }
      }
    }
  }

  async getAvailableMcpTools() {
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

  async getMcpClientByToolName(name) {
    for (const mcpClient of this.mcpClients) {
      const { tools } = mcpClient;
      if (tools && tools.some((tool) => tool.name === name)) {
        return mcpClient.client;
      }
    }
    return null;
  }

  async getMcpClientByToolId(id) {
    for (const mcpClient of this.mcpClients) {
      const { tools } = mcpClient;
      if (tools && tools.some((tool) => tool.id === id)) {
        return mcpClient.client;
      }
    }
    return null;
  }

  async callMcpTool(name, input) {
    const client = await this.getMcpClientByToolName(name);
    if (client) {
      try {
        const result = await client.callTool({
          name,
          arguments: input,
        });
        this.logger.debug({result}, 'LlmMcpService - result');
        return result;
      } catch (err) {
        this.logger.error({err}, 'LlmMcpService - error calling tool');
        throw err;
      }
    }
  }

  async close() {
    for (const mcpClient of this.mcpClients) {
      const { client } = mcpClient;
      if (client) {
        await client.close();
        this.logger.debug({url: mcpClient.url}, 'LlmMcpService - mcp client closed');
      }
    }
    this.mcpClients = [];
  }

}

module.exports = LlmMcpService;

