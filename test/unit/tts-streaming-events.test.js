const test = require('node:test');
const assert = require('node:assert');

/* call-session decrypts credentials at require time, so it needs a secret present */
process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'foobar';
process.env.JAMBONES_LOGLEVEL = process.env.JAMBONES_LOGLEVEL || 'error';

const CallSession = require('../../lib/session/call-session');

/* Only the requestor and logger are touched by these handlers, so the rest of a
   CallSession is deliberately left unbuilt. */
const makeSession = () => {
  const sent = [];
  const session = Object.create(CallSession.prototype);

  Object.assign(session, {
    application: {
      requestor: {
        request: async (type, hook, payload) => {
          sent.push({type, hook, payload});
        }
      }
    },
    logger: {info: () => {}, debug: () => {}, error: () => {}}
  });

  return {session, sent};
};

test('the stream_resumed event is sent to the same hook path as every other one', async () => {
  /* A hook path only gets joined to the application's baseUrl when it starts with
     a slash (HttpRequestor: `_isRelativeUrl(url) ? baseUrl + url : url`). Sending
     "streaming-event" instead of "/streaming-event" is neither relative nor
     absolute, so it never reaches an HTTP application at all — and the failure is
     swallowed by the .catch on the call site, so nothing surfaces. */
  const {session, sent} = makeSession();

  session._onTtsStreamingResume();
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].hook, '/streaming-event',
    'stream_resumed must use an absolute-from-base hook path');
  assert.strictEqual(sent[0].payload.event_type, 'stream_resumed');
});

test('pause and resume agree on the hook path', async () => {
  /* These two are a pair; if they ever diverge again, an application would get
     one half of the pause/resume cycle and silently lose the other. */
  const {session, sent} = makeSession();

  session._onTtsStreamingPause();
  session._onTtsStreamingResume();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepStrictEqual(
    sent.map(({hook}) => hook),
    ['/streaming-event', '/streaming-event']
  );
  assert.deepStrictEqual(
    sent.map(({payload}) => payload.event_type),
    ['stream_paused', 'stream_resumed']
  );
});
