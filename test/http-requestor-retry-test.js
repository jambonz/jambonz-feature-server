// Test for HttpRequestor retry functionality
const test = require('tape');
const sinon = require('sinon');
const HttpRequestor = require('../lib/utils/http-requestor');

// Mock dependencies
const MockLogger = {
  debug: () => {},
  info: () => {},
  error: () => {}
};

// Setup utility function
const setupRequestor = () => {
  const stats = { histogram: () => {} };
  const hook = { url: 'http://localhost/test', method: 'POST' };
  const requestor = new HttpRequestor(MockLogger, 'AC123', hook, 'testsecret');
  // Mock required internal methods for testing
  requestor._generateSigHeader = () => ({ 'X-Signature': 'test' });
  requestor._roundTrip = () => 10;
  requestor.stats = stats;
  requestor.Alerter = {
    AlertType: {
      WEBHOOK_CONNECTION_FAILURE: 'failure',
      WEBHOOK_STATUS_FAILURE: 'status'
    },
    writeAlerts: async () => {}
  };
  return requestor;
};

// Clean up after tests
const cleanup = (requestor) => {
  if (requestor) {
    if (requestor.client && !requestor.client.closed) {
      requestor.client.close();
    }
  }
  sinon.restore();
};

test('HttpRequestor: should retry on connection errors when specified in hash', async (t) => {
  const requestor = setupRequestor();
  
  // Setup a URL with retry params in the hash
  const urlWithRetry = 'http://localhost/test#rc=3&rp=ct,5xx';
  
  // First two calls fail with connection refused, third succeeds
  const requestStub = sinon.stub(requestor.client, 'request');
  const error = new Error('Connection refused');
  error.code = 'ECONNREFUSED';
  
  // Fail twice, succeed on third try
  requestStub.onCall(0).rejects(error);
  requestStub.onCall(1).rejects(error);
  requestStub.onCall(2).resolves({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: { json: async () => ({ success: true }) }
  });
  
  try {
    const hook = { url: urlWithRetry, method: 'GET' };
    const result = await requestor.request('verb:hook', hook, null);
    
    t.equal(requestStub.callCount, 3, 'Should have retried twice for a total of 3 calls');
    t.deepEqual(result, { success: true }, 'Should return successful response');
  } catch (err) {
    t.fail(`Should not throw an error: ${err.message}`);
  }
  
  cleanup(requestor);
  t.end();
});

test('HttpRequestor: should respect retry count (rc) from hash', async (t) => {
  const requestor = setupRequestor();
  
  // Setup a URL with retry params in the hash - only retry once
  const urlWithRetry = 'http://localhost/test#rc=1&rp=ct';
  
  // All calls fail with connection refused
  const requestStub = sinon.stub(requestor.client, 'request');
  const error = new Error('Connection refused');
  error.code = 'ECONNREFUSED';
  
  // Always fail
  requestStub.rejects(error);
  
  try {
    const hook = { url: urlWithRetry, method: 'GET' };
    await requestor.request('verb:hook', hook, null);
    t.fail('Should have thrown an error');
  } catch (err) {
    t.equal(requestStub.callCount, 2, 'Should have retried once for a total of 2 calls');
    t.equal(err.code, 'ECONNREFUSED', 'Should throw the original error');
  }
  
  cleanup(requestor);
  t.end();
});

test('HttpRequestor: should respect retry policy (rp) from hash', async (t) => {
  const requestor = setupRequestor();
  
  // Setup a URL with retry params in hash - only retry on 5xx errors
  const urlWithRetry = 'http://localhost/test#rc=2&rp=5xx';
  
  // Fail with 404 (should not retry since rp=5xx)
  const requestStub = sinon.stub(requestor.client, 'request');
  requestStub.resolves({
    statusCode: 404,
    headers: {},
    body: {}
  });
  
  try {
    const hook = { url: urlWithRetry, method: 'GET' };
    await requestor.request('verb:hook', hook, null);
    t.fail('Should have thrown an error');
  } catch (err) {
    t.equal(requestStub.callCount, 1, 'Should not retry on 404 when rp=5xx');
    t.equal(err.statusCode, 404, 'Should throw 404 error');
  }
  
  cleanup(requestor);
  t.end();
});

module.exports = {
  setupRequestor,
  cleanup
};
