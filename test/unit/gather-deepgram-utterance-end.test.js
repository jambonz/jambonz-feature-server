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
    _resolve: (reason, evt) => resolved.push({reason, transcript: evt.alternatives[0].transcript})
  });
  const fsEvent = {getHeader: () => undefined};
  const send = (evt) => gather._onTranscription(cs, {}, evt, fsEvent);
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

test('an empty final covering a stray interim word lets UtteranceEnd return the buffer', () => {
  const {gather, send, resolved} = makeGather();
  send(firstUtterance);
  send(strayInterim);
  assert.strictEqual(gather._dgTimeOfLastUnprocessedWord, 4.2);

  send(results({start: 3, duration: 2, is_final: true}));
  assert.strictEqual(gather._dgTimeOfLastUnprocessedWord, null);

  send(utteranceEnd);
  assert.deepStrictEqual(resolved, [{reason: 'speech', transcript: 'pay my bill'}]);
});

test('an empty final that ends before the interim word keeps UtteranceEnd waiting', () => {
  const {gather, send, resolved} = makeGather();
  send(firstUtterance);
  send(strayInterim);

  /* deepgram finalized [3, 4.0) but the word ending at 4.2 falls in the next segment */
  send(results({start: 3, duration: 1.0, is_final: true}));
  assert.strictEqual(gather._dgTimeOfLastUnprocessedWord, 4.2);

  send(utteranceEnd);
  assert.deepStrictEqual(resolved, []);
});

test('UtteranceEnd ahead of a late final still waits for it (#1088)', () => {
  const {send, resolved} = makeGather();
  send(firstUtterance);
  send(results({start: 3, duration: 1.5, is_final: false, words: [{word: 'please', start: 3.8, end: 4.2}]}));

  send(utteranceEnd);
  assert.deepStrictEqual(resolved, []);

  send(results({start: 3, duration: 1.5, is_final: true, words: [{word: 'please', start: 3.8, end: 4.2}]}));
  send({...utteranceEnd, last_word_end: 4.2});
  assert.deepStrictEqual(resolved, [{reason: 'speech', transcript: 'pay my bill please'}]);
});
