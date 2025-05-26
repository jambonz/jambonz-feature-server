// Patch require to return mocks (MUST be at the very top, before any other require)
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(path) {
  if (path === '../../') {
    return { 
      srf: { 
        locals: { 
          stats: { histogram: () => {} }
        } 
      } 
    };
  }
  if (path === '@jambonz/time-series') {
    return () => ({
      writeAlerts: async () => {},
      AlertType: {
        WEBHOOK_CONNECTION_FAILURE: 'WEBHOOK_CONNECTION_FAILURE',
        WEBHOOK_STATUS_FAILURE: 'WEBHOOK_STATUS_FAILURE'
      }
    });
  }
  if (path === 'mysql2/promise') {
    return {
      createConnection: () => Promise.resolve({
        connect: () => {},
        on: () => {},
        query: (sql, cb) => {
          if (typeof cb === 'function') cb(null, []);
          return { stream: () => ({ on: () => {} }) };
        },
        end: () => {}
      })
    };
  }
  if (path === 'mysql2') {
    return {
      createConnection: () => ({
        connect: () => {},
        on: () => {},
        query: (sql, cb) => {
          if (typeof cb === 'function') cb(null, []);
          return { stream: () => ({ on: () => {} }) };
        },
        end: () => {}
      })
    };
  }
  if (path === '@jambonz/db-helpers') {
    return {
      pool: {
        getConnection: () => Promise.resolve({
          connect: () => {},
          on: () => {},
          query: (sql, cb) => {
            if (typeof cb === 'function') cb(null, []);
            return { stream: () => ({ on: () => {} }) };
          },
          end: () => {}
        }),
        query: (...args) => {
          const cb = args[args.length - 1];
          if (typeof cb === 'function') cb(null, []);
          return Promise.resolve([]);
        }
      },
      camelize: (obj) => obj
    };
  }
  return originalRequire.apply(this, arguments);
};

// Now require everything else
const test = require('tape');
const sinon = require('sinon');

// Mocks
class MockLogger {
  debug() {}
  info() {}
  error() {}
}

// Setup function to create a clean requestor for each test
const BaseRequestor = require('../lib/utils/base-requestor');
const HttpRequestor = require('../lib/utils/http-requestor');

BaseRequestor.prototype._isAbsoluteUrl = function(url) { return url.startsWith('http'); };
BaseRequestor.prototype._isRelativeUrl = function(url) { return !url.startsWith('http'); };
BaseRequestor.prototype._generateSigHeader = function() { return { 'X-Signature': 'test-signature' }; };
BaseRequestor.prototype._roundTrip = function() { return 10; };
Object.defineProperty(BaseRequestor.prototype, 'baseUrl', { get: function() { return 'http://localhost'; } });
Object.defineProperty(BaseRequestor.prototype, 'Alerter', { 
  get: function() { 
    return { 
      AlertType: { 
        WEBHOOK_CONNECTION_FAILURE: 'WEBHOOK_CONNECTION_FAILURE', 
        WEBHOOK_STATUS_FAILURE: 'WEBHOOK_STATUS_FAILURE' 
      }, 
      writeAlerts: async () => {} 
    }; 
  } 
});

const setupRequestor = () => {
  const logger = new MockLogger();
  const hook = { url: 'http://localhost/test', method: 'POST' };
  const secret = 'testsecret';
  return new HttpRequestor(logger, 'AC123', hook, secret);
};

const cleanup = (requestor) => {
  sinon.restore();
  if (requestor && requestor.close) requestor.close();
};

test('HttpRequestor: constructor sets up properties correctly', (t) => {
  const requestor = setupRequestor();
  t.equal(requestor.method, 'POST', 'method should be POST');
  t.equal(requestor.url, 'http://localhost/test', 'url should be set');
  t.equal(typeof requestor.client, 'object', 'client should be an object');
  cleanup(requestor);
  t.end();
});

test('HttpRequestor: constructor with username/password sets auth header', (t) => {
  const logger = new MockLogger();
  const hook = { 
    url: 'http://localhost/test', 
    method: 'POST',
    username: 'user',
    password: 'pass'
  };
  const requestor = new HttpRequestor(logger, 'AC123', hook, 'secret');
  t.ok(requestor.authHeader.Authorization, 'Authorization header should be set');
  t.ok(requestor.authHeader.Authorization.startsWith('Basic '), 'Should be Basic auth');
  cleanup(requestor);
  t.end();
});

test('HttpRequestor: request should return JSON on 200 response', async (t) => {
  const requestor = setupRequestor();
  const expectedResponse = { success: true, data: [1, 2, 3] };
  const fakeBody = { json: async () => expectedResponse };
  sinon.stub(requestor.client, 'request').resolves({ 
    statusCode: 200, 
    headers: { 'content-type': 'application/json' }, 
    body: fakeBody 
  });
  try {
    const hook = { url: 'http://localhost/test', method: 'POST' };
    const result = await requestor.request('verb:hook', hook, { foo: 'bar' });
    t.deepEqual(result, expectedResponse, 'Should return parsed JSON');
    const requestCall = requestor.client.request.getCall(0);
    t.equal(requestCall.args[0], 'http://localhost', 'baseUrl should be passed');
    t.equal(requestCall.args[1].method, 'POST', 'method should be POST');
    t.ok(requestCall.args[1].headers['X-Signature'], 'Should include signature header');
    t.ok(requestCall.args[1].body, 'Should include request body');
  } catch (err) {
    t.fail(err);
  }
  cleanup(requestor);
  t.end();
});

test('HttpRequestor: request should handle non-200 responses', async (t) => {
  const requestor = setupRequestor();
  sinon.stub(requestor.client, 'request').resolves({ 
    statusCode: 404, 
    headers: {}, 
    body: {} 
  });
  try {
    const hook = { url: 'http://localhost/test', method: 'POST' };
    await requestor.request('verb:hook', hook, { foo: 'bar' });
    t.fail('Should have thrown an error');
  } catch (err) {
    t.ok(err, 'Should throw an error');
    t.equal(err.statusCode, 404, 'Error should contain status code');
  }
  cleanup(requestor);
  t.end();
});

test('HttpRequestor: request should handle ECONNREFUSED error', async (t) => {
  const requestor = setupRequestor();
  const error = new Error('Connection refused');
  error.code = 'ECONNREFUSED';
  sinon.stub(requestor.client, 'request').rejects(error);
  try {
    const hook = { url: 'http://localhost/test', method: 'POST' };
    await requestor.request('verb:hook', hook, { foo: 'bar' });
    t.fail('Should have thrown an error');
  } catch (err) {
    t.equal(err.code, 'ECONNREFUSED', 'Should pass through the error');
  }
  cleanup(requestor);
  t.end();
});

test('HttpRequestor: request should skip jambonz:error type', async (t) => {
  const requestor = setupRequestor();
  const spy = sinon.spy(requestor.client, 'request');
  const hook = { url: 'http://localhost/test', method: 'POST' };
  const result = await requestor.request('jambonz:error', hook, { foo: 'bar' });
  t.equal(result, undefined, 'Should return undefined');
  t.equal(spy.callCount, 0, 'Should not call request method');
  cleanup(requestor);
  t.end();
});

test('HttpRequestor: request should handle array response', async (t) => {
  const requestor = setupRequestor();
  const fakeBody = { json: async () => [{ id: 1 }, { id: 2 }] };
  sinon.stub(requestor.client, 'request').resolves({ 
    statusCode: 200, 
    headers: { 'content-type': 'application/json' }, 
    body: fakeBody 
  });
  try {
    const hook = { url: 'http://localhost/test', method: 'POST' };
    const result = await requestor.request('verb:hook', hook, { foo: 'bar' });
    t.ok(Array.isArray(result), 'Should return an array');
    t.equal(result.length, 2, 'Array should have 2 items');
  } catch (err) {
    t.fail(err);
  }
  cleanup(requestor);
  t.end();
});

test('HttpRequestor: request should handle llm:tool-call type', async (t) => {
  const requestor = setupRequestor();
  const fakeBody = { json: async () => ({ result: 'tool output' }) };
  sinon.stub(requestor.client, 'request').resolves({ 
    statusCode: 200, 
    headers: { 'content-type': 'application/json' }, 
    body: fakeBody 
  });
  try {
    const hook = { url: 'http://localhost/test', method: 'POST' };
    const result = await requestor.request('llm:tool-call', hook, { tool: 'test' });
    t.deepEqual(result, { result: 'tool output' }, 'Should return the parsed JSON');
  } catch (err) {
    t.fail(err);
  }
  cleanup(requestor);
  t.end();
});

test('HttpRequestor: close should close the client if not using pools', (t) => {
  // Ensure HTTP_POOL is set to false to disable pool usage
  const oldHttpPool = process.env.HTTP_POOL;
  process.env.HTTP_POOL = '0';
  
  const requestor = setupRequestor();
  // Make sure _usePools is false
  requestor._usePools = false;
  
  // Spy on the actual close method after construction
  const originalClose = requestor.client.close;
  const closeSpy = sinon.spy();
  requestor.client.close = closeSpy;
  requestor.client.closed = false;
  requestor.close();
  t.ok(closeSpy.calledOnce, 'Should call client.close');
  // Restore original close method
  requestor.client.close = originalClose;
  
  // Restore HTTP_POOL
  process.env.HTTP_POOL = oldHttpPool;
  cleanup(requestor);
  t.end();
});

test('HttpRequestor: request should handle URLs with fragments', async (t) => {
  const requestor = setupRequestor();
  // Use the same host/port as the base client to avoid creating a new client
  const urlWithFragment = 'http://localhost?param1=value1#rc=5&rp=4xx,5xx,ct';
  const expectedResponse = { status: 'success' };
  const fakeBody = { json: async () => expectedResponse };
  
  // Stub the request method
  const requestStub = sinon.stub(requestor.client, 'request').callsFake((url, opts) => {
    return Promise.resolve({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: fakeBody
    });
  });
  try {
    const hook = { url: urlWithFragment, method: 'GET' };
    const result = await requestor.request('verb:hook', hook, null);
    t.deepEqual(result, expectedResponse, 'Should return the parsed JSON response');
    const requestCall = requestStub.getCall(0);
    t.equal(requestCall.args[0], 'http://localhost', 'baseUrl should be passed');
    const requestOptions = requestCall.args[1];
    t.ok(requestOptions.query && requestOptions.query.param1 === 'value1', 'Query parameters should be parsed');
    t.equal(requestOptions.path, '/', 'Path should be extracted from URL');
    t.notOk(requestOptions.query && requestOptions.query.rc, 'Fragment should not be included in query parameters');
  } catch (err) {
    t.fail(err);
  }
  cleanup(requestor);
  t.end();
});