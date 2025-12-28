const test = require('tape');
const sinon = require('sinon');

const noop = () => {};
const logger = {
  error: noop,
  info: noop,
  debug: noop
};

// Mock the constants module
const TtsStreamingEvents = {
  Empty: 'tts_streaming::empty',
  Pause: 'tts_streaming::pause',
  Resume: 'tts_streaming::resume',
  ConnectFailure: 'tts_streaming::connect_failed',
  Connected: 'tts_streaming::connected'
};

const TtsStreamingConnectionStatus = {
  NotConnected: 'not_connected',
  Connected: 'connected',
  Connecting: 'connecting',
  Failed: 'failed'
};

// Create mock for constants module before requiring TtsStreamingBuffer
const proxyquire = require('proxyquire');

const TtsStreamingBuffer = proxyquire('../lib/utils/tts-streaming-buffer', {
  '../utils/constants': {
    TtsStreamingEvents,
    TtsStreamingConnectionStatus,
    DeepgramTtsStreamingEvents: {
      Empty: 'deepgram_tts_streaming::empty',
      ConnectFailure: 'deepgram_tts_streaming::connect_failed',
      Connect: 'deepgram_tts_streaming::connect'
    },
    CartesiaTtsStreamingEvents: {
      Empty: 'cartesia_tts_streaming::empty',
      ConnectFailure: 'cartesia_tts_streaming::connect_failed',
      Connect: 'cartesia_tts_streaming::connect'
    },
    ElevenlabsTtsStreamingEvents: {
      Empty: 'elevenlabs_tts_streaming::empty',
      ConnectFailure: 'elevenlabs_tts_streaming::connect_failed',
      Connect: 'elevenlabs_tts_streaming::connect'
    },
    RimelabsTtsStreamingEvents: {
      Empty: 'rimelabs_tts_streaming::empty',
      ConnectFailure: 'rimelabs_tts_streaming::connect_failed',
      Connect: 'rimelabs_tts_streaming::connect'
    },
    CustomTtsStreamingEvents: {
      Empty: 'custom_tts_streaming::empty',
      ConnectFailure: 'custom_tts_streaming::connect_failed',
      Connect: 'custom_tts_streaming::connect'
    }
  }
});

// Helper to create a mock CallSession
function createMockCs(options = {}) {
  const mockEp = {
    uuid: 'test-uuid-1234',
    api: sinon.stub().resolves({ body: '+OK' }),
    addCustomEventListener: sinon.stub(),
    removeCustomEventListener: sinon.stub()
  };

  return {
    logger,
    ep: mockEp,
    isTtsStreamOpen: options.isTtsStreamOpen !== undefined ? options.isTtsStreamOpen : true,
    getTsStreamingVendor: () => options.vendor || 'deepgram'
  };
}

/**
 * BUG REPRODUCTION TEST
 *
 * This test reproduces the exact issue from production logs:
 * {
 *   "args": ["uuid", "send", " "],
 *   "msg": "Error calling uuid_deepgram_tts_streaming: -USAGE: <uuid> connect|send|clear|close [tokens]"
 * }
 *
 * Root cause: When multiple flushes are queued while connecting, and a space token
 * gets buffered between flushes, Phase 1 of _feedQueue sends that space to the TTS vendor.
 *
 * Sequence:
 * 1. bufferTokens('Hello.') while connecting
 * 2. flush() while connecting
 * 3. bufferTokens(' ') while connecting (passes because bufferedLength > 0)
 * 4. flush() while connecting
 * 5. Connection completes, _feedQueue processes: [text:Hello., flush, text:" ", flush]
 * 6. First flush sends "Hello." - OK
 * 7. Second flush sends " " - BUG!
 */
test('TtsStreamingBuffer: multiple flushes while connecting - space token sent to TTS vendor', async(t) => {
  const cs = createMockCs();
  const buffer = new TtsStreamingBuffer(cs);

  buffer._connectionStatus = TtsStreamingConnectionStatus.Connecting;
  buffer.vendor = 'deepgram';

  const apiCalls = [];
  const originalApi = buffer._api.bind(buffer);
  buffer._api = async function(ep, args) {
    apiCalls.push({ args: [...args] });
    return originalApi(ep, args);
  };

  // First batch while connecting
  await buffer.bufferTokens('Hello.');
  buffer.flush();

  // Second batch - just a space (passes because bufferedLength > 0)
  await buffer.bufferTokens(' ');
  buffer.flush();

  // Verify queue state before connect
  t.equal(buffer.queue.length, 4, 'queue should have 4 items: [text, flush, text, flush]');
  t.equal(buffer.queue[0].type, 'text', 'first item should be text');
  t.equal(buffer.queue[0].value, 'Hello.', 'first text should be "Hello."');
  t.equal(buffer.queue[1].type, 'flush', 'second item should be flush');
  t.equal(buffer.queue[2].type, 'text', 'third item should be text');
  t.equal(buffer.queue[2].value, ' ', 'third item should be space');
  t.equal(buffer.queue[3].type, 'flush', 'fourth item should be flush');

  // Connect - triggers _feedQueue
  buffer._connectionStatus = TtsStreamingConnectionStatus.Connected;
  await buffer._feedQueue();

  // Check API calls
  const sendCalls = apiCalls.filter(call => call.args[1] === 'send');

  // This assertion will FAIL until the bug is fixed
  const whitespaceOnlySends = sendCalls.filter(call => /^\s*$/.test(call.args[2]));

  t.equal(whitespaceOnlySends.length, 0,
    `should not send whitespace-only tokens, but sent: ${whitespaceOnlySends.map(c => JSON.stringify(c.args[2])).join(', ')}`);

  t.end();
});

/**
 * Additional test: Verify text with trailing space in same flush is OK
 */
test('TtsStreamingBuffer: text with trailing space in same flush should work', async(t) => {
  const cs = createMockCs();
  const buffer = new TtsStreamingBuffer(cs);

  buffer._connectionStatus = TtsStreamingConnectionStatus.Connecting;
  buffer.vendor = 'deepgram';

  const apiCalls = [];
  const originalApi = buffer._api.bind(buffer);
  buffer._api = async function(ep, args) {
    apiCalls.push({ args: [...args] });
    return originalApi(ep, args);
  };

  // Buffer text with trailing space, then flush
  await buffer.bufferTokens('Hello.');
  await buffer.bufferTokens(' ');
  buffer.flush();

  // Connect
  buffer._connectionStatus = TtsStreamingConnectionStatus.Connected;
  await buffer._feedQueue();

  const sendCalls = apiCalls.filter(call => call.args[1] === 'send');

  t.equal(sendCalls.length, 1, 'should have one send call');
  t.equal(sendCalls[0].args[2], 'Hello. ', 'should send "Hello. " (text with trailing space)');

  t.end();
});

/**
 * Test: Leading whitespace should be discarded when buffer is empty
 */
test('TtsStreamingBuffer: leading whitespace discarded when buffer empty', async(t) => {
  const cs = createMockCs();
  const buffer = new TtsStreamingBuffer(cs);

  buffer._connectionStatus = TtsStreamingConnectionStatus.Connected;
  buffer.vendor = 'deepgram';

  // Try to buffer whitespace when buffer is empty
  const result = await buffer.bufferTokens('   ');

  t.equal(result.status, 'ok', 'should return ok status');
  t.equal(buffer.bufferedLength, 0, 'buffer should remain empty');
  t.equal(buffer.queue.length, 0, 'queue should remain empty');

  t.end();
});

/**
 * Test: Whitespace can be buffered when buffer has content
 */
test('TtsStreamingBuffer: whitespace accepted when buffer has content', async(t) => {
  const cs = createMockCs();
  const buffer = new TtsStreamingBuffer(cs);

  buffer._connectionStatus = TtsStreamingConnectionStatus.Connecting;
  buffer.vendor = 'deepgram';

  // Buffer real text first
  await buffer.bufferTokens('Hello');

  // Now buffer whitespace (should pass because bufferedLength > 0)
  const result = await buffer.bufferTokens(' ');

  t.equal(result.status, 'ok', 'should return ok status');
  t.equal(buffer.bufferedLength, 6, 'buffer should have 6 chars');
  t.equal(buffer.queue.length, 2, 'queue should have 2 items');

  t.end();
});
