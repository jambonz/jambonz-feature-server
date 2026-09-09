const test = require('tape');
const sinon = require('sinon');
const CallSession = require('../lib/session/call-session');

// Regression test for #1548: _lccTtsTokens must not silently drop a tts:tokens
// command that is missing `id`. It should reply with a tts:tokens-result of
// status 'failed'/reason 'missing id', mirroring how a missing `tokens` field
// is already handled — otherwise the WS client (e.g. the Python SDK, which does
// not send `id`) gets no feedback at all.

const buildFakeSession = () => {
  const requestor = { request: sinon.stub().resolves({}) };
  const logger = { info: sinon.stub(), debug: sinon.stub() };
  return { requestor, logger, ttsStreamingBuffer: { bufferTokens: sinon.stub().resolves({}) } };
};

test('_lccTtsTokens: missing id returns a failed tts:tokens-result instead of silently dropping', async (t) => {
  const session = buildFakeSession();

  // WHEN a tts:tokens command arrives without `id`
  await CallSession.prototype._lccTtsTokens.call(session, {tokens: 'hello world'});

  // THEN a tts:tokens-result with status 'failed'/reason 'missing id' is sent back
  t.ok(session.requestor.request.calledOnce, 'requestor.request should be called once');
  const [type, path, payload] = session.requestor.request.firstCall.args;
  t.equal(type, 'tts:tokens-result', 'response type is tts:tokens-result');
  t.equal(path, '/tokens-result', 'response path is /tokens-result');
  t.equal(payload.status, 'failed', 'status is failed');
  t.equal(payload.reason, 'missing id', 'reason is missing id');

  // AND tokens are never buffered for an invalid command
  t.ok(session.ttsStreamingBuffer.bufferTokens.notCalled, 'tokens are not buffered when id is missing');
  t.end();
});
