const test = require('node:test');
const assert = require('node:assert');

const TaskGather = require('../../lib/tasks/gather');

const logger = {debug() {}, info() {}, error() {}, warn() {}};

/* a continuous-asr deepgram gather; the constructor is not run, only what _onTranscription touches is set */
const makeGather = () => {
  const resolved = [];
  const gather = Object.create(TaskGather.prototype);
  const {normalizeTranscription, consolidateTranscripts} = require('../../lib/utils/transcription-utils')(logger);
  const cs = {emit() {}, calculateSttLatency() {}, callGone: false};
  Object.assign(gather, {
    logger,
    normalizeTranscription,
    consolidateTranscripts,
    vendor: 'deepgram',
    language: 'en-US',
    data: {recognizer: {}},
    isContinuousAsr: true,
    asrTimeout: 2000,
    _bufferedTranscripts: [],
    _sonioxTranscripts: [],
    cs,
    eventIsForOurBug: () => true,
    doesVendorContinueListeningAfterFinalTranscript: () => true,
    _clearTimer: () => false,
    _startTimer() {},
    _startAsrTimer() {},
    _clearAsrTimer() {},
    _resolve(reason, evt) {
      this.resolved = true;
      resolved.push({reason, transcript: evt.alternatives[0].transcript});
    }
  });
  const fsEvent = {getHeader: () => undefined};
  /* a deferred UtteranceEnd resolves on setImmediate, after the final has been handled */
  const send = async(evt) => {
    gather._onTranscription(cs, {}, evt, fsEvent);
    await new Promise((resolve) => setImmediate(resolve));
  };
  return {gather, send, resolved};
};

const results = ({start, duration, is_final, speech_final = false, words = []}) => ({
  type: 'Results',
  start,
  duration,
  is_final,
  speech_final,
  channel: {
    alternatives: [{
      transcript: words.map((w) => w.word).join(' '),
      confidence: 0.9,
      words
    }]
  }
});

const firstUtterance = results({
  start: 0, duration: 3, is_final: true,
  words: [{word: 'pay', start: 0.5, end: 1.0}, {word: 'my', start: 1.1, end: 1.4}, {word: 'bill', start: 1.5, end: 2.9}]
});
const strayInterim = results({start: 3, duration: 1.5, is_final: false, words: [{word: 'uh', start: 4.0, end: 4.2}]});
const utteranceEnd = {type: 'UtteranceEnd', channel: [0, 1], last_word_end: 2.9};

test('an empty final covering a stray interim word lets UtteranceEnd return the buffer', async() => {
  const {gather, send, resolved} = makeGather();
  await send(firstUtterance);
  await send(strayInterim);
  assert.strictEqual(gather._dgTimeOfLastUnprocessedWord, 4.2);

  await send(results({start: 3, duration: 2, is_final: true}));
  assert.strictEqual(gather._dgTimeOfLastUnprocessedWord, null);

  await send(utteranceEnd);
  assert.deepStrictEqual(resolved, [{reason: 'speech', transcript: 'pay my bill'}]);
});

test('an empty final that ends before the interim word keeps UtteranceEnd waiting', async() => {
  const {gather, send, resolved} = makeGather();
  await send(firstUtterance);
  await send(strayInterim);

  /* deepgram finalized [3, 4.0) but the word ending at 4.2 falls in the next segment */
  await send(results({start: 3, duration: 1.0, is_final: true}));
  assert.strictEqual(gather._dgTimeOfLastUnprocessedWord, 4.2);

  await send(utteranceEnd);
  assert.deepStrictEqual(resolved, []);
});

test('an empty final arriving after a deferred UtteranceEnd returns the buffer', async() => {
  const {send, resolved} = makeGather();
  await send(firstUtterance);
  await send(strayInterim);

  await send(utteranceEnd);
  assert.deepStrictEqual(resolved, []);

  /* deepgram sends no second UtteranceEnd until new speech, so this final must end the gather */
  await send(results({start: 3, duration: 2, is_final: true}));
  assert.deepStrictEqual(resolved, [{reason: 'speech', transcript: 'pay my bill'}]);
});

test('a final with words after a deferred UtteranceEnd keeps listening for the next UtteranceEnd (#1088)', async() => {
  const {send, resolved} = makeGather();
  await send(firstUtterance);
  await send(results({start: 3, duration: 1.5, is_final: false, words: [{word: 'please', start: 3.8, end: 4.2}]}));

  await send(utteranceEnd);
  assert.deepStrictEqual(resolved, []);

  /* the caller may still be talking, so the words alone must not end the gather */
  await send(results({start: 3, duration: 1.5, is_final: true, words: [{word: 'please', start: 3.8, end: 4.2}]}));
  assert.deepStrictEqual(resolved, []);

  await send({...utteranceEnd, last_word_end: 4.2});
  assert.deepStrictEqual(resolved, [{reason: 'speech', transcript: 'pay my bill please'}]);
});

test('a deferred UtteranceEnd is not resolved by a final that ends before the pending word', async() => {
  const {send, resolved} = makeGather();
  await send(firstUtterance);
  await send(strayInterim);

  await send(utteranceEnd);
  await send(results({start: 3, duration: 1.0, is_final: true}));
  assert.deepStrictEqual(resolved, []);
});
