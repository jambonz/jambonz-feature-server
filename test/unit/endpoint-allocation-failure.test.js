const test = require('node:test');
const assert = require('node:assert');

/* call-session decrypts credentials at require time, so it needs a secret present */
process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'foobar';
process.env.JAMBONES_LOGLEVEL = process.env.JAMBONES_LOGLEVEL || 'error';

const CallSession = require('../../lib/session/call-session');

/* only what _evalEndpointPrecondition touches when endpoint creation fails */
const makeSession = ({finalResponseSent = false} = {}) => {
  const calls = {released: 0};
  const session = Object.create(CallSession.prototype);
  Object.assign(session, {
    callGone: false,
    ep: null,
    req: {body: 'v=0'},
    res: {finalResponseSent, send: () => {}},
    logger: {debug: () => {}, info: () => {}, error: () => {}},
    _createMediaEndpoint: async() => { throw new Error('timeout creating media endpoint'); },
    _callReleased: () => calls.released++
  });
  return {session, calls};
};

test('endpoint creation failure ends an unanswered call as a media server failure', async() => {
  const {session, calls} = makeSession();

  await assert.rejects(session._evalEndpointPrecondition({name: 'play'}), /unable to allocate endpoint/);

  assert.strictEqual(session._mediaServerFailure, true);
  assert.strictEqual(calls.released, 1, 'later verbs must not retry against a dead media server');
});

test('endpoint creation failure after a final response leaves the session alone', async() => {
  const {session, calls} = makeSession({finalResponseSent: true});

  await assert.rejects(session._evalEndpointPrecondition({name: 'play'}));

  assert.ok(!session._mediaServerFailure);
  assert.strictEqual(calls.released, 0);
});
