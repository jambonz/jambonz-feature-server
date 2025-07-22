const test = require('tape');
const sinon = require('sinon');
const proxyquire = require("proxyquire");
proxyquire.noCallThru();

const {
  JAMBONES_LOGLEVEL,  
} = require('../lib/config');
const logger = require('pino')({level: JAMBONES_LOGLEVEL});

// Mock WebSocket specifically for retry testing
class RetryMockWebSocket {
  static retryScenarios = new Map();
  static connectionAttempts = new Map();
  static urlMapping = new Map(); // Maps cleanUrl -> originalUrl
  
  constructor(url, protocols, options) {
    this.url = url;
    this.protocols = protocols;
    this.options = options;
    this.eventListeners = new Map();
    
    // Extract scenario key from URL hash or use URL itself
    this.scenarioKey = this.extractScenarioKey(url);
    
    // Track connection attempts for this scenario
    const attempts = RetryMockWebSocket.connectionAttempts.get(this.scenarioKey) || 0;
    RetryMockWebSocket.connectionAttempts.set(this.scenarioKey, attempts + 1);
    
    // Handle connection immediately
    setImmediate(() => {
      this.handleConnection();
    });
  }
  
  extractScenarioKey(url) {
    console.log(`RetryMockWebSocket: extractScenarioKey from URL: ${url}`);
    
    // Check if we have a mapping from cleanUrl to originalUrl
    const originalUrl = RetryMockWebSocket.urlMapping.get(url);
    if (originalUrl && originalUrl.includes('#')) {
      const hash = originalUrl.split('#')[1];
      console.log(`RetryMockWebSocket: found mapped URL with hash: ${hash}`);
      return hash;
    }
    
    // For URLs with hash parameters, use the hash as the scenario key
    if (url.includes('#')) {
      const hash = url.split('#')[1];
      console.log(`RetryMockWebSocket: found hash: ${hash}`);
      return hash; // Use hash as scenario key
    }
    
    console.log(`RetryMockWebSocket: using full URL as scenario key: ${url}`);
    return url; // Fallback to full URL
  }
  
  static setRetryScenario(key, scenario) {
    RetryMockWebSocket.retryScenarios.set(key, scenario);
  }
  
  static setUrlMapping(cleanUrl, originalUrl) {
    RetryMockWebSocket.urlMapping.set(cleanUrl, originalUrl);
  }
  
  static clearScenarios() {
    RetryMockWebSocket.retryScenarios.clear();
    RetryMockWebSocket.connectionAttempts.clear();
    RetryMockWebSocket.urlMapping.clear();
  }
  
  static getConnectionAttempts(key) {
    return RetryMockWebSocket.connectionAttempts.get(key) || 0;
  }
  
  handleConnection() {
    const scenario = RetryMockWebSocket.retryScenarios.get(this.scenarioKey);
    console.log(`RetryMockWebSocket: handleConnection for scenarioKey="${this.scenarioKey}", scenario found:`, !!scenario);
    
    if (!scenario) {
      // Default successful connection
      this.simulateOpen();
      return;
    }
    
    const attemptNumber = RetryMockWebSocket.connectionAttempts.get(this.scenarioKey);
    const behavior = scenario.attempts[attemptNumber - 1] || scenario.attempts[scenario.attempts.length - 1];
    
    console.log(`RetryMockWebSocket: attempt ${attemptNumber}, behavior:`, behavior);
    
    if (behavior.type === 'handshake-failure') {
      // Simulate handshake failure with specific status code
      setImmediate(() => {
        console.log(`RetryMockWebSocket: triggering handshake failure with status ${behavior.statusCode}`);
        if (this.eventListeners.has('unexpected-response')) {
          const mockResponse = {
            statusCode: behavior.statusCode || 500,
            statusMessage: behavior.statusMessage || 'Internal Server Error',
            headers: {}
          };
          const mockRequest = {
            headers: {}
          };
          this.eventListeners.get('unexpected-response')(mockRequest, mockResponse);
        }
      });
    } else if (behavior.type === 'network-error') {
      // Simulate network error during connection
      setImmediate(() => {
        console.log(`RetryMockWebSocket: triggering network error: ${behavior.message}`);
        if (this.eventListeners.has('error')) {
          const err = new Error(behavior.message || 'Network error');
          // Set appropriate error codes based on the message
          if (behavior.message === 'Connection timeout') {
            err.code = 'ETIMEDOUT';
          } else if (behavior.message === 'Connection refused') {
            err.code = 'ECONNREFUSED';
          } else if (behavior.message === 'Connection reset') {
            err.code = 'ECONNRESET';
          } else {
            // Default to ECONNREFUSED for generic network errors
            err.code = 'ECONNREFUSED';
          }
          this.eventListeners.get('error')(err);
        }
      });
    } else if (behavior.type === 'success') {
      // Successful connection
      console.log(`RetryMockWebSocket: triggering success`);
      this.simulateOpen();
    }
  }
  
  simulateOpen() {
    setImmediate(() => {
      if (this.eventListeners.has('open')) {
        this.eventListeners.get('open')();
      }
    });
  }
  
  once(event, listener) {
    this.eventListeners.set(event, listener);
    return this;
  }
  
  on(event, listener) {
    this.eventListeners.set(event, listener);
    return this;
  }
  
  removeAllListeners() {
    this.eventListeners.clear();
  }
  
  send(data, callback) {
    // For successful connections, simulate message response
    try {
      const json = JSON.parse(data);
      console.log({json}, 'RetryMockWebSocket: got message from ws-requestor');
      
      // Simulate successful response
      setTimeout(() => {
        const msg = {
          type: 'ack',
          msgid: json.msgid,
          command: 'command',
          call_sid: json.call_sid,
          queueCommand: false,
          data: '[{"verb": "play","url": "silence_stream://5000"}]'
        };
        console.log({msg}, 'RetryMockWebSocket: sending ack to ws-requestor');
        this.mockOnMessage(JSON.stringify(msg));
      }, 50);
      
      if (callback) callback();
    } catch (err) {
      console.error('RetryMockWebSocket: Error processing send', err);
      if (callback) callback(err);
    }
  }
  
  mockOnMessage(message, isBinary = false) {
    if (this.eventListeners.has('message')) {
      this.eventListeners.get('message')(message, isBinary);
    }
  }
  
  close(code) {
    if (this.eventListeners.has('close')) {
      this.eventListeners.get('close')(code || 1000);
    }
  }
}

const BaseRequestor = proxyquire(
  "../lib/utils/base-requestor",
  {
    "../../": {
      srf: {
        locals: {
          stats: {
            histogram: () => {}
          }
        }
      }
    },
    "@jambonz/time-series": sinon.stub()
  }
);

const WsRequestor = proxyquire(
  "../lib/utils/ws-requestor",
  {
    "./base-requestor": BaseRequestor,
    "ws": RetryMockWebSocket
  }
);

test('WS Retry - 4xx error with rp=4xx should retry and succeed', async (t) => {
  // GIVEN
  RetryMockWebSocket.clearScenarios();
  
  const originalUrl = 'ws://localhost:3000#rc=2&rp=4xx';
  const cleanUrl = 'ws://localhost:3000';
  
  // Set up URL mapping so mock can find the right scenario
  RetryMockWebSocket.setUrlMapping(cleanUrl, originalUrl);
  
  const retryScenario = {
    attempts: [
      { type: 'handshake-failure', statusCode: 400, statusMessage: 'Bad Request' },
      { type: 'success' }
    ]
  };
  RetryMockWebSocket.setRetryScenario('rc=2&rp=4xx', retryScenario);
  
  const hook = {
    url: originalUrl,
    username: 'username',
    password: 'password'
  };
  
  const params = {
    callSid: 'test_4xx_retry'
  };
  
  // WHEN
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  const result = await requestor.request('session:new', hook, params, {});
  
  // THEN
  t.ok(result, 'ws successfully retried after 4xx error and got response');
  t.equal(RetryMockWebSocket.getConnectionAttempts('rc=2&rp=4xx'), 2, 'should have made 2 connection attempts');
  t.end();
});

test('WS Retry - 4xx error with rp=5xx should not retry', async (t) => {
  // GIVEN
  RetryMockWebSocket.clearScenarios();
  
  const originalUrl = 'ws://localhost:3000#rc=2&rp=5xx';
  const cleanUrl = 'ws://localhost:3000';
  
  // Set up URL mapping so mock can find the right scenario
  RetryMockWebSocket.setUrlMapping(cleanUrl, originalUrl);
  
  const retryScenario = {
    attempts: [
      { type: 'handshake-failure', statusCode: 400, statusMessage: 'Bad Request' }
    ]
  };
  RetryMockWebSocket.setRetryScenario('rc=2&rp=5xx', retryScenario);
  
  const hook = {
    url: originalUrl,
    username: 'username',
    password: 'password'
  };
  
  const params = {
    callSid: 'test_4xx_no_retry'
  };
  
  // WHEN & THEN
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  try {
    await requestor.request('session:new', hook, params, {});
    t.fail('Should have thrown an error');
  } catch (err) {
    const errorMessage = err.message || err.toString() || String(err);
    t.ok(errorMessage.includes('400'), 'ws properly failed without retry for 4xx when rp=5xx');
    t.equal(RetryMockWebSocket.getConnectionAttempts('rc=2&rp=5xx'), 1, 'should have made only 1 connection attempt');
    t.end();
  }
});

test('WS Retry - 5xx error with rp=5xx should retry and succeed', async (t) => {
  // GIVEN
  RetryMockWebSocket.clearScenarios();
  
  const originalUrl = 'ws://localhost:3000#rc=2&rp=5xx';
  const cleanUrl = 'ws://localhost:3000';
  
  // Set up URL mapping so mock can find the right scenario
  RetryMockWebSocket.setUrlMapping(cleanUrl, originalUrl);
  
  const retryScenario = {
    attempts: [
      { type: 'handshake-failure', statusCode: 503, statusMessage: 'Service Unavailable' },
      { type: 'success' }
    ]
  };
  RetryMockWebSocket.setRetryScenario('rc=2&rp=5xx', retryScenario);
  
  const hook = {
    url: originalUrl,
    username: 'username',
    password: 'password'
  };
  
  const params = {
    callSid: 'test_5xx_retry'
  };
  
  // WHEN
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  const result = await requestor.request('session:new', hook, params, {});
  
  // THEN
  t.ok(result, 'ws successfully retried after 5xx error and got response');
  t.equal(RetryMockWebSocket.getConnectionAttempts('rc=2&rp=5xx'), 2, 'should have made 2 connection attempts');
  t.end();
});

test('WS Retry - 5xx error with rp=4xx should not retry', async (t) => {
  // GIVEN
  RetryMockWebSocket.clearScenarios();
  
  const originalUrl = 'ws://localhost:3000#rc=2&rp=4xx';
  const cleanUrl = 'ws://localhost:3000';
  
  // Set up URL mapping so mock can find the right scenario
  RetryMockWebSocket.setUrlMapping(cleanUrl, originalUrl);
  
  const retryScenario = {
    attempts: [
      { type: 'handshake-failure', statusCode: 503, statusMessage: 'Service Unavailable' }
    ]
  };
  RetryMockWebSocket.setRetryScenario('rc=2&rp=4xx', retryScenario);
  
  const hook = {
    url: originalUrl,
    username: 'username',
    password: 'password'
  };
  
  const params = {
    callSid: 'test_5xx_no_retry'
  };
  
  // WHEN & THEN
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  try {
    await requestor.request('session:new', hook, params, {});
    t.fail('Should have thrown an error');
  } catch (err) {
    const errorMessage = err.message || err.toString() || String(err);
    t.ok(errorMessage.includes('503'), 'ws properly failed without retry for 5xx when rp=4xx');
    t.equal(RetryMockWebSocket.getConnectionAttempts('rc=2&rp=4xx'), 1, 'should have made only 1 connection attempt');
    t.end();
  }
});

test('WS Retry - network error with rp=all should retry and succeed', async (t) => {
  // GIVEN
  RetryMockWebSocket.clearScenarios();
  
  const originalUrl = 'ws://localhost:3000#rc=2&rp=all';
  const cleanUrl = 'ws://localhost:3000';
  
  // Set up URL mapping so mock can find the right scenario
  RetryMockWebSocket.setUrlMapping(cleanUrl, originalUrl);
  
  const retryScenario = {
    attempts: [
      { type: 'network-error', message: 'Connection refused' },
      { type: 'success' }
    ]
  };
  RetryMockWebSocket.setRetryScenario('rc=2&rp=all', retryScenario);
  
  const hook = {
    url: originalUrl,
    username: 'username',
    password: 'password'
  };
  
  const params = {
    callSid: 'test_network_retry'
  };
  
  // WHEN
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  const result = await requestor.request('session:new', hook, params, {});
  
  // THEN
  t.ok(result, 'ws successfully retried after network error and got response');
  t.equal(RetryMockWebSocket.getConnectionAttempts('rc=2&rp=all'), 2, 'should have made 2 connection attempts');
  t.end();
});

test('WS Retry - network error with rp=4xx should not retry', async (t) => {
  // GIVEN
  RetryMockWebSocket.clearScenarios();
  
  const originalUrl = 'ws://localhost:3000#rc=2&rp=4xx';
  const cleanUrl = 'ws://localhost:3000';
  
  // Set up URL mapping so mock can find the right scenario
  RetryMockWebSocket.setUrlMapping(cleanUrl, originalUrl);
  
  const retryScenario = {
    attempts: [
      { type: 'network-error', message: 'Connection refused' }
    ]
  };
  RetryMockWebSocket.setRetryScenario('rc=2&rp=4xx', retryScenario);
  
  const hook = {
    url: originalUrl,
    username: 'username',
    password: 'password'
  };
  
  const params = {
    callSid: 'test_network_no_retry'
  };
  
  // WHEN & THEN
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  try {
    await requestor.request('session:new', hook, params, {});
    t.fail('Should have thrown an error');
  } catch (err) {
    const errorMessage = err.message || err.toString() || String(err);
    t.ok(errorMessage.includes('Connection refused') || errorMessage.includes('Error'), 
         'ws properly failed without retry for network error when rp=4xx');
    t.equal(RetryMockWebSocket.getConnectionAttempts('rc=2&rp=4xx'), 1, 'should have made only 1 connection attempt');
    t.end();
  }
});

test('WS Retry - multiple retries then success', async (t) => {
  // GIVEN
  RetryMockWebSocket.clearScenarios();
  
  const originalUrl = 'ws://localhost:3000#rc=4&rp=all';
  const cleanUrl = 'ws://localhost:3000';
  
  // Set up URL mapping so mock can find the right scenario
  RetryMockWebSocket.setUrlMapping(cleanUrl, originalUrl);
  
  const retryScenario = {
    attempts: [
      { type: 'handshake-failure', statusCode: 503, statusMessage: 'Service Unavailable' },
      { type: 'network-error', message: 'Connection timeout' },
      { type: 'handshake-failure', statusCode: 502, statusMessage: 'Bad Gateway' },
      { type: 'success' }
    ]
  };
  RetryMockWebSocket.setRetryScenario('rc=4&rp=all', retryScenario);
  
  const hook = {
    url: originalUrl,
    username: 'username',
    password: 'password'
  };
  
  const params = {
    callSid: 'test_multiple_retries'
  };
  
  // WHEN
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  const result = await requestor.request('session:new', hook, params, {});
  
  // THEN
  t.ok(result, 'ws successfully retried multiple times and got response');
  t.equal(RetryMockWebSocket.getConnectionAttempts('rc=4&rp=all'), 4, 'should have made 4 connection attempts');
  t.end();
});

test('WS Retry - exhaust retries and fail', async (t) => {
  // GIVEN
  RetryMockWebSocket.clearScenarios();
  
  const originalUrl = 'ws://localhost:3000#rc=2&rp=5xx';
  const cleanUrl = 'ws://localhost:3000';
  
  // Set up URL mapping so mock can find the right scenario
  RetryMockWebSocket.setUrlMapping(cleanUrl, originalUrl);
  
  const retryScenario = {
    attempts: [
      { type: 'handshake-failure', statusCode: 503, statusMessage: 'Service Unavailable' },
      { type: 'handshake-failure', statusCode: 503, statusMessage: 'Service Unavailable' },
      { type: 'handshake-failure', statusCode: 503, statusMessage: 'Service Unavailable' }
    ]
  };
  RetryMockWebSocket.setRetryScenario('rc=2&rp=5xx', retryScenario);
  
  const hook = {
    url: originalUrl,
    username: 'username',
    password: 'password'
  };
  
  const params = {
    callSid: 'test_exhaust_retries'
  };
  
  // WHEN & THEN
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  try {
    await requestor.request('session:new', hook, params, {});
    t.fail('Should have thrown an error');
  } catch (err) {
    const errorMessage = err.message || err.toString() || String(err);
    t.ok(errorMessage.includes('503'), 'ws properly failed after exhausting retries');
    t.equal(RetryMockWebSocket.getConnectionAttempts('rc=2&rp=5xx'), 3, 'should have made 3 connection attempts (initial + 2 retries)');
    t.end();
  }
});

test('WS Retry - rp=ct (connection timeout) should retry network errors', async (t) => {
  // GIVEN
  RetryMockWebSocket.clearScenarios();
  
  const originalUrl = 'ws://localhost:3000#rc=2&rp=ct';
  const cleanUrl = 'ws://localhost:3000';
  
  // Set up URL mapping so mock can find the right scenario
  RetryMockWebSocket.setUrlMapping(cleanUrl, originalUrl);
  
  const retryScenario = {
    attempts: [
      { type: 'network-error', message: 'Connection timeout' },
      { type: 'success' }
    ]
  };
  RetryMockWebSocket.setRetryScenario('rc=2&rp=ct', retryScenario);
  
  const hook = {
    url: originalUrl,
    username: 'username',
    password: 'password'
  };
  
  const params = {
    callSid: 'test_ct_retry'
  };
  
  // WHEN
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  const result = await requestor.request('session:new', hook, params, {});
  
  // THEN
  t.ok(result, 'ws successfully retried connection timeout and got response');
  t.equal(RetryMockWebSocket.getConnectionAttempts('rc=2&rp=ct'), 2, 'should have made 2 connection attempts');
  t.end();
});

test('WS Retry - default behavior (no hash params) should use ct policy', async (t) => {
  // GIVEN
  RetryMockWebSocket.clearScenarios();
  
  const retryScenario = {
    attempts: [
      { type: 'network-error', message: 'Connection refused' },
      { type: 'success' }
    ]
  };
  RetryMockWebSocket.setRetryScenario('ws://localhost:3000', retryScenario);
  
  const hook = {
    url: 'ws://localhost:3000', // No hash parameters - should default to ct policy
    username: 'username',
    password: 'password'
  };
  
  const params = {
    callSid: 'test_default_policy'
  };
  
  // WHEN
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  const result = await requestor.request('session:new', hook, params, {});
  
  // THEN
  t.ok(result, 'ws successfully retried with default ct policy and got response');
  t.equal(RetryMockWebSocket.getConnectionAttempts('ws://localhost:3000'), 2, 'should have made 2 connection attempts');
  t.end();
});
