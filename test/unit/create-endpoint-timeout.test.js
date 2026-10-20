const test = require('node:test');
const assert = require('node:assert');

const {createEndpointWithTimeout} = require('../../lib/utils/media-endpoint');

const logger = {info: () => {}, debug: () => {}, error: () => {}};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a media server that never answers fails endpoint creation instead of hanging', async() => {
  const ms = {createEndpoint: () => new Promise(() => {})};

  await assert.rejects(createEndpointWithTimeout(ms, {}, logger, 50), /timeout creating media endpoint/);
});

test('an endpoint that arrives after the timeout is destroyed', async() => {
  let destroyed = 0;
  const ep = {destroy: async() => { destroyed++; }};
  const ms = {createEndpoint: () => sleep(100).then(() => ep)};

  await assert.rejects(createEndpointWithTimeout(ms, {}, logger, 50));
  await sleep(100);

  assert.strictEqual(destroyed, 1);
});

test('a prompt endpoint is returned untouched', async() => {
  const ep = {destroy: async() => assert.fail('must not destroy')};
  const ms = {createEndpoint: async() => ep};

  assert.strictEqual(await createEndpointWithTimeout(ms, {}, logger, 50), ep);
});

test('a media server error is passed through', async() => {
  const ms = {createEndpoint: async() => { throw new Error('488 Not Acceptable'); }};

  await assert.rejects(createEndpointWithTimeout(ms, {}, logger, 50), /488/);
});

test('a timeout of 0 waits for the media server however long it takes', async() => {
  const ep = {destroy: async() => assert.fail('must not destroy')};
  const ms = {createEndpoint: () => sleep(100).then(() => ep)};

  assert.strictEqual(await createEndpointWithTimeout(ms, {}, logger, 0), ep);
});
