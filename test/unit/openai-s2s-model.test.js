const test = require('node:test');
const assert = require('node:assert');
const TaskLlmOpenAI_S2S = require('../../lib/tasks/llm/llms/openai_s2s');

const noop = () => {};
const logger = {error: noop, info: noop, debug: noop, warn: noop};

const make = (parent) => new TaskLlmOpenAI_S2S(logger, {llmOptions: {response_create: {}}}, {
  auth: {apiKey: 'k'}, addCustomEventListener: noop, removeCustomEventListeners: noop, ...parent
});

test('openai: with no model the default is gpt-realtime-2.1', () => {
  assert.strictEqual(make({vendor: 'openai'}).path, 'v1/realtime?model=gpt-realtime-2.1');
});

test('openai: an explicit model is used as given', () => {
  assert.strictEqual(make({vendor: 'openai', model: 'gpt-realtime-2.1-mini'}).path,
    'v1/realtime?model=gpt-realtime-2.1-mini');
});

test('azure openai: with no model the deployment default is unchanged', () => {
  const task = make({vendor: 'microsoft', connectOptions: {host: 'res.openai.azure.com'}});
  assert.strictEqual(task.path,
    'openai/realtime?api-version=2024-10-01-preview&deployment=gpt-4o-realtime-preview-2024-12-17');
});
