const test = require('node:test');
const assert = require('node:assert');
const Emitter = require('events');

const DtmfInput = require('../../lib/utils/dtmf-input');

const noop = () => {};

const make = (t, opts) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const keys = [];
  const entries = [];
  const warnings = [];
  const logger = {error: noop, info: noop, debug: noop, warn: (...args) => warnings.push(args)};
  const ep = new Emitter();
  const input = new DtmfInput(logger, opts, {
    onKey: (d) => keys.push(d),
    onEntry: (digits) => entries.push(digits)
  });
  input.start(ep);
  const press = (digits) => [...digits].forEach((dtmf) => ep.emit('dtmf', {dtmf}));
  const tick = (secs) => t.mock.timers.tick(secs * 1000);
  return {ep, input, keys, entries, warnings, press, tick};
};

test('finishOnKey completes the entry and is not included', (t) => {
  const {keys, entries, press} = make(t, {finishOnKey: '#'});
  press('1234#');
  assert.deepStrictEqual(entries, ['1234']);
  assert.deepStrictEqual(keys, ['1', '2', '3', '4', '#']);
});

test('finishOnKey on an empty buffer sends nothing', (t) => {
  const {entries, press} = make(t, {finishOnKey: '#'});
  press('#');
  assert.deepStrictEqual(entries, []);
});

test('no finishOnKey by default: # is an ordinary digit', (t) => {
  const {entries, press} = make(t, {numDigits: 3});
  press('1#2');
  assert.deepStrictEqual(entries, ['1#2']);
});

test('numDigits completes the entry', (t) => {
  const {entries, press} = make(t, {numDigits: 2});
  press('1234');
  assert.deepStrictEqual(entries, ['12', '34']);
});

test('maxDigits completes the entry', (t) => {
  const {entries, press} = make(t, {maxDigits: 3});
  press('12345');
  assert.deepStrictEqual(entries, ['123']);
});

test('each key restarts the inter-digit timer', (t) => {
  const {entries, press, tick} = make(t, {interDigitTimeout: 2});
  press('56');
  tick(1.5);
  press('7');
  tick(1.5);
  assert.deepStrictEqual(entries, []);
  tick(0.5);
  assert.deepStrictEqual(entries, ['567']);
});

test('the inter-digit timer replaces the overall timeout while typing', (t) => {
  const {entries, press, tick} = make(t, {interDigitTimeout: 5, timeout: 15});
  for (let i = 0; i < 20; i++) {
    press(String(i % 10));
    tick(1);
  }
  assert.deepStrictEqual(entries, []);
  tick(4);
  assert.deepStrictEqual(entries, ['01234567890123456789']);
});

test('interDigitTimeout waits for minDigits', (t) => {
  const {entries, press, tick} = make(t, {interDigitTimeout: 1, minDigits: 3, timeout: 0});
  press('12');
  tick(5);
  assert.deepStrictEqual(entries, []);
  press('3');
  tick(1);
  assert.deepStrictEqual(entries, ['123']);
});

test('timeout defaults to 15s and completes the entry', (t) => {
  const {entries, press, tick} = make(t, {});
  press('42');
  tick(14.9);
  assert.deepStrictEqual(entries, []);
  tick(0.1);
  assert.deepStrictEqual(entries, ['42']);
});

test('timeout below minDigits drops the entry', (t) => {
  const {entries, press, tick} = make(t, {timeout: 1, minDigits: 3});
  press('42');
  tick(1);
  assert.deepStrictEqual(entries, []);
});

test('warns when no option can ever complete an entry', (t) => {
  assert.strictEqual(make(t, {timeout: 0}).warnings.length, 1);
});

test('no warning when one option completes an entry', (t) => {
  assert.strictEqual(make(t, {timeout: 0, finishOnKey: '#'}).warnings.length, 0);
});

test('stop removes only its own listener and discards the buffer', (t) => {
  const {ep, input, entries, press, tick} = make(t, {interDigitTimeout: 1});
  ep.on('dtmf', noop);
  press('9');
  input.stop();
  tick(2);
  press('8');
  assert.deepStrictEqual(entries, []);
  assert.deepStrictEqual(ep.listeners('dtmf'), [noop]);
});
