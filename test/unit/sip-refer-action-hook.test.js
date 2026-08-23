const test = require('node:test');
const assert = require('node:assert');
const Emitter = require('events');
const {context} = require('@opentelemetry/api');
const {KillReason} = require('../../lib/utils/constants');
const proxyquire = require('proxyquire').noCallThru();

const ACTION_HOOK = '/refer-action';
const REFER_TO = '+15551234567';
const REFER_ACCEPTED = 202;
const REFER_DECLINED = 603;
const FINAL_NOTIFY_STATUS = 200;
const NOTIFY_TIMEOUT_MS = 15000;
const FAKE_TRACE_ID = '0'.repeat(32);
const FAKE_SPAN_ID = '0'.repeat(16);

/* Task#startSpan pulls the tracer off the app module singleton; stub it so the verb can be
   exercised without booting the feature server */
const fakeSpan = {
  setAttributes: () => {},
  end: () => {},
  spanContext: () => ({traceId: FAKE_TRACE_ID, spanId: FAKE_SPAN_ID})
};
const TaskSipRefer = proxyquire('../../lib/tasks/sip_refer', {
  '../..': {
    srf: {locals: {otel: {tracer: {startSpan: () => fakeSpan}}}},
    '@global': true,
    '@noCallThru': true
  }
});

const noop = () => {};
const logger = {info: noop, debug: noop, error: noop};

/* minimal CallSession stand-in: a dialog that answers the REFER, and a requestor that
   records every hook it is asked to fire */
const makeCallSession = (referStatus) => {
  const hookCalls = [];
  const dlg = new Emitter();
  dlg.local = {uri: 'sip:jambonz@example.com'};
  dlg.remote = {uri: 'sip:carrier@10.10.10.10'};
  dlg.request = async() => ({status: referStatus});

  return {
    hookCalls,
    dlg,
    replacedWith: [],
    replaceApplication(tasks) {
      this.replacedWith.push(tasks);
    },
    req: {callingNumber: '+15550000000', callingName: 'jambonz'},
    callInfo: {toJSON: () => ({call_sid: 'call-sid-under-test'})},
    requestor: {
      request: async(type, hook, params) => {
        hookCalls.push({type, hook, params});
      }
    }
  };
};

const makeTask = () => {
  const task = new TaskSipRefer(logger, {referTo: REFER_TO, actionHook: ACTION_HOOK});
  task.ctx = context.active();
  return task;
};

/* let the REFER request/response round trip settle before driving the next event */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const makeNotify = (status) => {
  const req = {
    get: (name) => ('Content-Type' === name ? 'message/sipfrag;version=2.0' : undefined),
    body: `SIP/2.0 ${status} OK`
  };
  return {req, res: {send: () => {}}};
};

test('sip:refer actionHook fires when the far end sends BYE before any NOTIFY', async() => {
  const cs = makeCallSession(REFER_ACCEPTED);
  const task = makeTask();
  const execPromise = task.exec(cs);
  await settle();

  /* the BYE tears the call session down, which kills the running task */
  task.kill(cs);
  await execPromise;

  assert.strictEqual(cs.hookCalls.length, 1, 'actionHook should have been called exactly once');
  assert.strictEqual(cs.hookCalls[0].hook, ACTION_HOOK);
  assert.strictEqual(cs.hookCalls[0].params.refer_status, REFER_ACCEPTED);
});

test('sip:refer actionHook fires once, with the final status, when a NOTIFY arrives', async() => {
  const cs = makeCallSession(REFER_ACCEPTED);
  const task = makeTask();
  const execPromise = task.exec(cs);
  await settle();

  const {req, res} = makeNotify(FINAL_NOTIFY_STATUS);
  cs.dlg.emit('notify', req, res);
  await execPromise;

  assert.strictEqual(cs.hookCalls.length, 1, 'actionHook should have been called exactly once');
  assert.strictEqual(cs.hookCalls[0].params.refer_status, REFER_ACCEPTED);
  assert.strictEqual(cs.hookCalls[0].params.final_referred_call_status, FINAL_NOTIFY_STATUS);
});

test('sip:refer actionHook fires when the far end rejects the REFER', async() => {
  const cs = makeCallSession(REFER_DECLINED);
  const task = makeTask();

  await task.exec(cs);

  assert.strictEqual(cs.hookCalls.length, 1, 'actionHook should have been called exactly once');
  assert.strictEqual(cs.hookCalls[0].params.refer_status, REFER_DECLINED);
});

test('a failing actionHook is logged, not thrown out of the verb', async() => {
  const cs = makeCallSession(REFER_ACCEPTED);
  cs.requestor.request = async() => {
    throw new Error('actionHook unreachable');
  };
  const task = makeTask();
  const execPromise = task.exec(cs);
  await settle();

  task.kill(cs);
  await assert.doesNotReject(execPromise);
});

test('sip:refer actionHook fires when no NOTIFY arrives before the timeout', async(t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const cs = makeCallSession(REFER_ACCEPTED);
  const task = makeTask();
  const execPromise = task.exec(cs);
  await settle();

  t.mock.timers.tick(NOTIFY_TIMEOUT_MS);
  await execPromise;

  assert.strictEqual(cs.hookCalls.length, 1, 'actionHook should have been called exactly once');
  assert.strictEqual(cs.hookCalls[0].params.refer_status, REFER_ACCEPTED);
});

test('exec waits for an in-flight actionHook when a BYE races the final NOTIFY', async() => {
  const cs = makeCallSession(REFER_ACCEPTED);
  let releaseHook;
  const hookGate = new Promise((resolve) => {
    releaseHook = resolve;
  });
  const recordHook = cs.requestor.request;
  cs.requestor.request = async(...args) => {
    await hookGate;
    return recordHook(...args);
  };

  const task = makeTask();
  const execPromise = task.exec(cs);
  await settle();

  const {req, res} = makeNotify(FINAL_NOTIFY_STATUS);
  cs.dlg.emit('notify', req, res);
  await settle();

  /* the BYE lands while the actionHook request started by the NOTIFY is still in flight */
  task.kill(cs);
  let execResolved = false;
  execPromise.then(() => {
    execResolved = true;
  });
  await settle();
  assert.strictEqual(execResolved, false, 'exec must not resolve while the actionHook is in flight');

  releaseHook();
  await execPromise;
  assert.strictEqual(cs.hookCalls.length, 1, 'actionHook should have been called exactly once');
});

test('an actionHook response replaces the application only when the verb was not itself replaced', async() => {
  for (const [killReason, expectedReplacements] of [[undefined, 1], [KillReason.Replaced, 0]]) {
    const cs = makeCallSession(REFER_ACCEPTED);
    cs.requestor.request = async() => [{verb: 'hangup'}];
    const task = makeTask();
    const execPromise = task.exec(cs);
    await settle();

    task.kill(cs, killReason);
    await execPromise;

    assert.strictEqual(cs.replacedWith.length, expectedReplacements,
      `killReason=${killReason} should produce ${expectedReplacements} application replacement(s)`);
  }
});
