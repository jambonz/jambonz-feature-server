process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'unit-test';
const test = require('node:test');
const assert = require('node:assert');

const TtsTask = require('../../lib/tasks/tts-task');

const logger = {debug() {}, info() {}, error() {}, warn() {}};
const {setChannelVarsForStt, normalizeTranscription} = require('../../lib/utils/transcription-utils')(logger);

const credentials = {
  username: 'u1', password: 'p1', slug: 's1',
  stt_uri: 'wss://stt.example.com/v1',
  tts_uri: 'wss://tts.example.com/base',
  model_id: 'viaspeech-x',
};

test('viadialog stt sets the access token, base url and model', () => {
  const task = {name: 'gather', data: {}};
  const opts = setChannelVarsForStt(task, {...credentials, access_token: 'tok'}, 'fr-FR', {vendor: 'viadialog'});
  assert.equal(opts.VIADIALOG_ACCESS_TOKEN, 'tok');
  assert.equal(opts.VIADIALOG_STT_URI, 'wss://stt.example.com/v1');
  assert.equal(opts.VIADIALOG_MODEL, 'viaspeech-x');
  assert.equal(opts.OPENAI_API_KEY, undefined);
});

test('viadialog stt model from the recognizer overrides the credential', () => {
  const opts = setChannelVarsForStt({name: 'gather', data: {}}, {...credentials, access_token: 'tok'}, 'fr-FR',
    {vendor: 'viadialog', model: 'other-model'});
  assert.equal(opts.VIADIALOG_MODEL, 'other-model');
});

test('viadialog transcript is normalized as a final result', () => {
  const evt = {type: 'conversation.item.input_audio_transcription.completed', transcript: 'bonjour', item_id: 'abc'};
  const t = normalizeTranscription(evt, 'viadialog', 1, 'fr-FR');
  assert.equal(t.is_final, true);
  assert.equal(t.alternatives[0].transcript, 'bonjour');
  assert.equal(t.vendor.name, 'viadialog');
  assert.equal(t.language_code, 'fr-FR');
});

const makeTts = () => {
  const task = Object.create(TtsTask.prototype);
  Object.assign(task, {
    logger,
    options: {voice_settings: {speed: 0}},
  });
  return task;
};

/* say.js passes cs explicitly: this.cs is not set yet when streaming starts */
const makeCs = (calls) => ({srf: {locals: {dbHelpers: {getViadialogAccessToken: async(c) => {
  calls.push(c);
  return {access_token: 'tok-tts', servedFromCache: false};
}}}}});

test('viadialog tts streaming logs in and sets channel vars', async() => {
  const calls = [];
  const task = makeTts();
  const set = [];
  await task.setTtsStreamingChannelVars('viadialog', 'fr-FR', 'cecile', credentials,
    {set: async(o) => set.push(o)}, makeCs(calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].username, 'u1');
  const vars = set[0];
  assert.equal(vars.VIADIALOG_ACCESS_TOKEN, 'tok-tts');
  assert.equal(vars.VIADIALOG_TTS_URI, 'wss://tts.example.com/base');
  assert.equal(vars.VIADIALOG_TTS_STREAMING_VOICE_ID, 'cecile');
  assert.equal(vars.VIADIALOG_TTS_STREAMING_LANGUAGE, 'fr');
  assert.equal(vars.VIADIALOG_TTS_STREAMING_VOICE_SETTINGS_SPEED, '0');
});

test('viadialog tts streaming omits a language the server cannot speak', async() => {
  const set = [];
  await makeTts().setTtsStreamingChannelVars('viadialog', 'de-DE', 'cecile', credentials,
    {set: async(o) => set.push(o)}, makeCs([]));
  assert.equal(set[0].VIADIALOG_TTS_STREAMING_LANGUAGE, '');
  assert.equal(set[0].VIADIALOG_TTS_STREAMING_MODEL_ID, '');
});
