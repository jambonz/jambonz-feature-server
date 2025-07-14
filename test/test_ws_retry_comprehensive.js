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
    
    console.log(`RetryMockWebSocket: constructor for URL ${url}, scenarioKey="${this.scenarioKey}", attempt #${attempts + 1}`);
    
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
    console.log(`RetryMockWebSocket: setting scenario for key "${key}":`, scenario);
    RetryMockWebSocket.retryScenarios.set(key, scenario);
  }
  
  static setUrlMapping(cleanUrl, originalUrl) {
    console.log(`RetryMockWebSocket: mapping ${cleanUrl} -> ${originalUrl}`);
    RetryMockWebSocket.urlMapping.set(cleanUrl, originalUrl);
  }
  
  static clearScenarios() {
    console.log('RetryMockWebSocket: clearing all scenarios');
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
      console.log(`RetryMockWebSocket: no scenario found, defaulting to success`);
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
          const error = new Error(behavior.message || 'Network error');
          // Set proper error code for retry policy checking
          if (behavior.message && behavior.message.includes('Connection refused')) {
            error.code = 'ECONNREFUSED';
          } else if (behavior.message && behavior.message.includes('timeout')) {
            error.code = 'ETIMEDOUT';
          } else {
            error.code = 'ECONNREFUSED'; // Default for network errors
          }
          this.eventListeners.get('error')(error);
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
        console.log(`RetryMockWebSocket: calling open listener`);
        this.eventListeners.get('open')();
      }
    });
  }
  
  once(event, listener) {
    console.log(`RetryMockWebSocket: registering once listener for ${event}`);
    this.eventListeners.set(event, listener);
    return this;
  }
  
  on(event, listener) {
    console.log(`RetryMockWebSocket: registering on listener for ${event}`);
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

const BaseRequestor = proxyquire('../lib/utils/base-requestor', {
  '../../': {
    srf: {
      locals: {
        stats: {
          histogram: () => {},
        },
      },
    },
  },
  '@jambonz/time-series': sinon.stub(),
});

const WsRequestor = proxyquire('../lib/utils/ws-requestor', {
  './base-requestor': BaseRequestor,
  ws: RetryMockWebSocket,
});

test('ws retry policy - 4xx error with rp=5xx should not retry', async(t) => {
  // GIVEN
  console.log('Starting test setup...');
  RetryMockWebSocket.clearScenarios();

  const call_sid = 'ws_no_retry_4xx';
  
  // Set up the URL mapping
  const cleanUrl = 'ws://localhost:3000';
  const originalUrl = 'ws://localhost:3000#rc=2&rp=5xx';
  RetryMockWebSocket.setUrlMapping(cleanUrl, originalUrl);
  
  // Set up the retry scenario for the first attempt to fail with 400, but policy only retries 5xx
  RetryMockWebSocket.setRetryScenario('rc=2&rp=5xx', {
    attempts: [
      { type: 'handshake-failure', statusCode: 400, statusMessage: 'Bad Request' }
    ]
  });

  const hook = {
    url: 'ws://localhost:3000#rc=2&rp=5xx', // Max 2 retries, retry only on 5xx
    username: 'username',
    password: 'password',
  };

  const params = {
    callSid: call_sid,
  };

  // WHEN
  const requestor = new WsRequestor(
    logger,
    'account_sid',
    hook,
    'webhook_secret'
  );
  try {
    const result = await requestor.request('session:new', hook, params, {});
    t.fail('Should have thrown an error');
    t.end();
  } catch (err) {
    // THEN
    const errorMessage = err.message || err.toString() || String(err);
    t.ok(
      errorMessage.includes('400'),
      `ws properly failed without retry for 4xx when rp=5xx - error: ${errorMessage}`
    );
    t.end();
  }
});

test('ws retry policy - 5xx error with rp=5xx should retry and succeed', async(t) => {
  // GIVEN
  console.log('Starting 5xx retry test setup...');
  RetryMockWebSocket.clearScenarios();

  const call_sid = 'ws_retry_5xx_success';
  
  // Set up the URL mapping
  const cleanUrl = 'ws://localhost:3000';
  const originalUrl = 'ws://localhost:3000#rc=2&rp=5xx';
  RetryMockWebSocket.setUrlMapping(cleanUrl, originalUrl);
  
  // Set up the retry scenario - first attempt fails with 500, second succeeds
  RetryMockWebSocket.setRetryScenario('rc=2&rp=5xx', {
    attempts: [
      { type: 'handshake-failure', statusCode: 500, statusMessage: 'Internal Server Error' },
      { type: 'success' }
    ]
  });

  const hook = {
    url: 'ws://localhost:3000#rc=2&rp=5xx', // Max 2 retries, retry only on 5xx
    username: 'username',
    password: 'password',
  };

  const params = {
    callSid: call_sid,
  };

  // WHEN
  const requestor = new WsRequestor(
    logger,
    'account_sid',
    hook,
    'webhook_secret'
  );
  try {
    const result = await requestor.request('session:new', hook, params, {});
    
    // THEN
    t.ok(result, 'ws successfully retried and connected after 5xx error');
    
    // Verify that exactly 2 attempts were made
    const attempts = RetryMockWebSocket.getConnectionAttempts('rc=2&rp=5xx');
    t.equal(attempts, 2, 'Should have made exactly 2 connection attempts');
    
    t.end();
  } catch (err) {
    t.fail(`Should have succeeded after retry - error: ${err.message}`);
    t.end();
  }
});

test('ws retry policy - network error with rp=ct should retry and succeed', async(t) => {
  // GIVEN
  console.log('Starting network error retry test setup...');
  RetryMockWebSocket.clearScenarios();

  const call_sid = 'ws_retry_network_success';
  
  // Set up the URL mapping
  const cleanUrl = 'ws://localhost:3000';
  const originalUrl = 'ws://localhost:3000#rc=3&rp=ct';
  RetryMockWebSocket.setUrlMapping(cleanUrl, originalUrl);
  
  // Set up the retry scenario - first two attempts fail with network error, third succeeds
  RetryMockWebSocket.setRetryScenario('rc=3&rp=ct', {
    attempts: [
      { type: 'network-error', message: 'Connection refused' },
      { type: 'network-error', message: 'Connection refused' },
      { type: 'success' }
    ]
  });

  const hook = {
    url: 'ws://localhost:3000#rc=3&rp=ct', // Max 3 retries, retry on connection errors
    username: 'username',
    password: 'password',
  };

  const params = {
    callSid: call_sid,
  };

  // WHEN
  const requestor = new WsRequestor(
    logger,
    'account_sid',
    hook,
    'webhook_secret'
  );
  try {
    const result = await requestor.request('session:new', hook, params, {});
    
    // THEN
    t.ok(result, 'ws successfully retried and connected after network errors');
    
    // Verify that exactly 3 attempts were made
    const attempts = RetryMockWebSocket.getConnectionAttempts('rc=3&rp=ct');
    t.equal(attempts, 3, 'Should have made exactly 3 connection attempts');
    
    t.end();
  } catch (err) {
    t.fail(`Should have succeeded after retry - error: ${err.message}`);
    t.end();
  }
});

test('ws retry policy - retry exhaustion should fail with last error', async(t) => {
  // GIVEN
  console.log('Starting retry exhaustion test setup...');
  RetryMockWebSocket.clearScenarios();

  const call_sid = 'ws_retry_exhaustion';
  
  // Set up the URL mapping
  const cleanUrl = 'ws://localhost:3000';
  const originalUrl = 'ws://localhost:3000#rc=2&rp=5xx';
  RetryMockWebSocket.setUrlMapping(cleanUrl, originalUrl);
  
  // Set up the retry scenario - all attempts fail with 500
  RetryMockWebSocket.setRetryScenario('rc=2&rp=5xx', {
    attempts: [
      { type: 'handshake-failure', statusCode: 500, statusMessage: 'Internal Server Error' },
      { type: 'handshake-failure', statusCode: 500, statusMessage: 'Internal Server Error' },
      { type: 'handshake-failure', statusCode: 500, statusMessage: 'Internal Server Error' }
    ]
  });

  const hook = {
    url: 'ws://localhost:3000#rc=2&rp=5xx', // Max 2 retries, retry only on 5xx
    username: 'username',
    password: 'password',
  };

  const params = {
    callSid: call_sid,
  };

  // WHEN
  const requestor = new WsRequestor(
    logger,
    'account_sid',
    hook,
    'webhook_secret'
  );
  try {
    const result = await requestor.request('session:new', hook, params, {});
    t.fail('Should have thrown an error after exhausting retries');
    t.end();
  } catch (err) {
    // THEN
    const errorMessage = err.message || err.toString() || String(err);
    t.ok(
      errorMessage.includes('500'),
      `ws properly failed after exhausting retries - error: ${errorMessage}`
    );
    
    // Verify that exactly 3 attempts were made (initial + 2 retries)
    const attempts = RetryMockWebSocket.getConnectionAttempts('rc=2&rp=5xx');
    t.equal(attempts, 3, 'Should have made exactly 3 connection attempts (initial + 2 retries)');
    
    t.end();
  }
});
