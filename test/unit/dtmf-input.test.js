const test = require('node:test');
const assert = require('node:assert');
const Emitter = require('events');

const DtmfInput = require('../../lib/utils/dtmf-input');

const noop = () => {};
const logger = {error: noop, info: noop, debug: noop, warn: noop};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const make = (opts) => {
  const keys = [];
  const entries = [];
  const ep = new Emitter();
  const input = new DtmfInput(logger, opts, {
    onKey: (d) => keys.push(d),
    onEntry: (digits) => entries.push(digits)
  });
  input.start(ep);
  const press = (digits) => [...digits].forEach((dtmf) => ep.emit('dtmf', {dtmf}));
  return {ep, input, keys, entries, press};
};

test('finishOnKey completes the entry and is not included', () => {
  const {input, keys, entries, press} = make({finishOnKey: '#'});
  press('1234#');
  assert.deepStrictEqual(entries, ['1234']);
  assert.deepStrictEqual(keys, ['1', '2', '3', '4', '#']);
  input.stop();
});

test('finishOnKey on an empty buffer sends nothing', () => {
  const {input, entries, press} = make({finishOnKey: '#'});
  press('#');
  assert.deepStrictEqual(entries, []);
  input.stop();
});

test('no finishOnKey by default: # is an ordinary digit', () => {
  const {input, entries, press} = make({numDigits: 3});
  press('1#2');
  assert.deepStrictEqual(entries, ['1#2']);
  input.stop();
});

test('numDigits and maxDigits complete the entry', () => {
  const a = make({numDigits: 2});
  a.press('1234');
  assert.deepStrictEqual(a.entries, ['12', '34']);
  a.input.stop();
  const b = make({maxDigits: 3});
  b.press('12345');
  assert.deepStrictEqual(b.entries, ['123']);
  b.input.stop();
});

test('interDigitTimeout completes the entry once the caller stops typing', async() => {
  const {input, entries, press} = make({interDigitTimeout: 0.05});
  press('56');
  await wait(25);
  press('7');
  await wait(30);
  assert.deepStrictEqual(entries, [], 'each key restarts the inter-digit timer');
  await wait(40);
  assert.deepStrictEqual(entries, ['567']);
  input.stop();
});

test('interDigitTimeout waits for minDigits', async() => {
  const {input, entries, press} = make({interDigitTimeout: 0.03, minDigits: 3, timeout: 0});
  press('12');
  await wait(60);
  assert.deepStrictEqual(entries, []);
  press('3');
  await wait(60);
  assert.deepStrictEqual(entries, ['123']);
  input.stop();
});

test('timeout completes the entry, or drops it below minDigits', async() => {
  const a = make({timeout: 0.05});
  a.press('42');
  await wait(80);
  assert.deepStrictEqual(a.entries, ['42']);
  a.input.stop();
  const b = make({timeout: 0.05, minDigits: 3});
  b.press('42');
  await wait(80);
  assert.deepStrictEqual(b.entries, []);
  b.input.stop();
});

test('stop removes only its own listener and discards the buffer', async() => {
  const {ep, input, entries, press} = make({interDigitTimeout: 0.03});
  const other = noop;
  ep.on('dtmf', other);
  press('9');
  input.stop();
  await wait(50);
  assert.deepStrictEqual(entries, []);
  assert.deepStrictEqual(ep.listeners('dtmf'), [other]);
});
