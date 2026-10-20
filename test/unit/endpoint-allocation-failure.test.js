const test = require('node:test');
const assert = require('node:assert');

/* call-session decrypts credentials at require time, so it needs a secret present */
process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'foobar';
process.env.JAMBONES_LOGLEVEL = process.env.JAMBONES_LOGLEVEL || 'error';

const CallSession = require('../../lib/session/call-session');

/* only what _evalEndpointPrecondition touches when endpoint creation fails */
const makeSession = ({finalResponseSent = false} = {}) => {
  const calls = {released: 0, creates: 0};
  const session = Object.create(CallSession.prototype);
  Object.assign(session, {
    callGone: false,
    ep: null,
    req: {body: 'v=0', locals: {}},
    callInfo: {callId: 'call-id', callSid: 'call-sid'},
    res: {finalResponseSent, send: () => {}},
    logger: {debug: () => {}, info: () => {}, error: () => {}},
    _createMediaEndpoint: async() => {
      calls.creates++;
      throw new Error('timeout creating media endpoint');
    },
    _callReleased: () => calls.released++
  });
  return {session, calls};
};

test('endpoint failure on an unanswered call marks the media server failed but keeps the session', async() => {
  const {session, calls} = makeSession();

  await assert.rejects(session._evalEndpointPrecondition({name: 'play'}), /unable to allocate endpoint/);

  assert.strictEqual(session._mediaServerFailure, true);
  /* a sip:decline or dial the app queued meanwhile must still run */
  assert.strictEqual(calls.released, 0);
});

test('later media verbs fail at once instead of waiting on the dead media server again', async() => {
  const {session, calls} = makeSession();

  await assert.rejects(session._evalEndpointPrecondition({name: 'play'}));
  await assert.rejects(session._evalEndpointPrecondition({name: 'llm'}), /media server unavailable/);

  assert.strictEqual(calls.creates, 1);
});

test('endpoint failure after a final response does not mark the media server failed', async() => {
  const {session, calls} = makeSession({finalResponseSent: true});

  await assert.rejects(session._evalEndpointPrecondition({name: 'play'}));

  assert.ok(!session._mediaServerFailure);
  assert.strictEqual(calls.released, 0);
});
