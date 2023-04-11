const test = require('tape');
const sinon = require('sinon');
const proxyquire = require("proxyquire");
proxyquire.noCallThru();
const MockWebsocket = require('./ws-mock')
const logger = require('pino')({level: process.env.JAMBONES_LOGLEVEL || 'error'});

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
    "ws": MockWebsocket
  }
 );

test('ws success', async (t) => {
  // GIVEN

  const json = '[{\"verb\": \"play\",\"url\": \"silence_stream://5000\"}]';
  const ws_response = {
    action: ['connect'],
    body: json
  }
  const call_sid = 'ws_success';

  MockWebsocket.addJsonMapping(call_sid, ws_response);

  const hook = {
    url: 'ws://localhost:3000',
    username: 'username',
    password: 'password'
  }

  const params = {
    callSid: call_sid
  }

  // WHEN
  
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  const result = await requestor.request('session:new',hook, params, {});

  // THEN
  t.ok(result == json,'ws successfully sent session:new and got initial jambonz app');

  t.end();
});

test('ws close success reconnect', async (t) => {
  // GIVEN

  const call_sid = 'ws_closed'
  const json = '[{\"verb\": \"play\",\"url\": \"silence_stream://5000\"}]';
  const ws_response = {
    action: ['close', 'connect'],
    body: json
  }
  MockWebsocket.addJsonMapping(call_sid, ws_response);

  const hook = {
    url: 'ws://localhost:3000',
    username: 'username',
    password: 'password'
  }

  const params = {
    callSid: call_sid
  }

  // WHEN
  
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  const result = await requestor.request('session:new',hook, params, {});

  // THEN
  t.ok(result == json,'ws successfully reconnect after close from far end');

  t.end();
});


test('ws response error 1000', async (t) => {
  // GIVEN

  const call_sid = 'ws_terminated'
  const json = '[{\"verb\": \"play\",\"url\": \"silence_stream://5000\"}]';
  const ws_response = {
    action: ['terminate'],
    body: json
  }
  MockWebsocket.addJsonMapping(call_sid, ws_response);

  const hook = {
    url: 'ws://localhost:3000',
    username: 'username',
    password: 'password'
  }

  const params = {
    callSid: call_sid
  }

  // WHEN
  
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  try {
    await requestor.request('session:new',hook, params, {});
  }
  catch (err) {
    // THEN
    t.ok(err.startsWith('timeout from far end for msgid'), 'ws does not reconnect if far end closes gracefully');
    t.end();
  }
});

test('ws response error', async (t) => {
  // GIVEN

  const call_sid = 'ws_error'
  const json = '[{\"verb\": \"play\",\"url\": \"silence_stream://5000\"}]';
  const ws_response = {
    action: ['error'],
    body: json
  }
  MockWebsocket.addJsonMapping(call_sid, ws_response);

  const hook = {
    url: 'ws://localhost:3000',
    username: 'username',
    password: 'password'
  }

  const params = {
    callSid: call_sid
  }

  // WHEN
  
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  try {
    await requestor.request('session:new',hook, params, {});
  }
  catch (err) {
    // THEN
    t.ok(err.startsWith('timeout from far end for msgid'), 'ws does not reconnect if far end closes gracefully');
    t.end();
  }
});

test('ws unexpected-response', async (t) => {
  // GIVEN

  const call_sid = 'ws_unexpected-response'
  const json = '[{\"verb\": \"play\",\"url\": \"silence_stream://5000\"}]';
  const ws_response = {
    action: ['unexpected-response'],
    body: json
  }
  MockWebsocket.addJsonMapping(call_sid, ws_response);

  const hook = {
    url: 'ws://localhost:3000',
    username: 'username',
    password: 'password'
  }

  const params = {
    callSid: call_sid
  }

  // WHEN
  
  const requestor = new WsRequestor(logger, "account_sid", hook, "webhook_secret");
  try {
    await requestor.request('session:new',hook, params, {});
  }
  catch (err) {
    // THEN
    t.ok(err.code = 'ERR_ASSERTION', 'ws does not reconnect if far end closes gracefully');
    t.end();
  }
});