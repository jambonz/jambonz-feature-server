const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const bent = require('bent');
const getJSON = bent('json')
const clearModule = require('clear-module');
const {provisionCallHook} = require('./utils')
const {
  GCP_JSON_KEY,
  AWS_ACCESS_KEY_ID,  
  AWS_SECRET_ACCESS_KEY,
  MICROSOFT_REGION,
  MICROSOFT_API_KEY,
  SONIOX_API_KEY,
  DEEPGRAM_API_KEY,
} = require('../lib/config');

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

function connect(connectable) {
  return new Promise((resolve, reject) => {
    connectable.on('connect', () => {
      return resolve();
    });
  });
}

test('\'transcribe\' test - google', async(t) => {
  if (!GCP_JSON_KEY) {
    t.pass('skipping google tests');
    return t.end();
  }
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);
    // GIVEN
    let verbs = [
      {
        "verb": "transcribe",
        "recognizer": {
          "vendor": "google",
          "hints": ["customer support", "sales", "human resources", "HR"]
        },
        "transcriptionHook": "/transcriptionHook"
      }
    ];
    let from = "gather_success";
    provisionCallHook(from, verbs);
    // THEN
    await sippUac('uac-gather-account-creds-success.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    t.ok(obj.body.speech.alternatives[0].transcript.toLowerCase().startsWith('i\'d like to speak to customer support'),
      'transcribe: succeeds when using google credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'transcribe\' test - microsoft', async(t) => {
  if (!MICROSOFT_REGION || !MICROSOFT_API_KEY) {
    t.pass('skipping microsoft tests');
    return t.end();
  }
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);
    // GIVEN
    let verbs = [
      {
        "verb": "transcribe",
        "recognizer": {
          "vendor": "microsoft",
          "hints": ["customer support", "sales", "human resources", "HR"]
        },
        "transcriptionHook": "/transcriptionHook"
      }
    ];
    let from = "gather_success";
    provisionCallHook(from, verbs);
    // THEN
    await sippUac('uac-gather-account-creds-success.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    t.ok(obj.body.speech.alternatives[0].transcript.toLowerCase().startsWith('i\'d like to speak to customer support'),
      'transcribe: succeeds when using  microsoft credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'transcribe\' test - aws', async(t) => {
  if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    t.pass('skipping aws tests');
    return t.end();
  }
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);
    // GIVEN
    let verbs = [
      {
        "verb": "transcribe",
        "recognizer": {
          "vendor": "aws",
          "hints": ["customer support", "sales", "human resources", "HR"]
        },
        "transcriptionHook": "/transcriptionHook"
      }
    ];
    let from = "gather_success";
    provisionCallHook(from, verbs);
    // THEN
    await sippUac('uac-gather-account-creds-success.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    t.ok(obj.body.speech.alternatives[0].transcript.toLowerCase().startsWith('i\'d like to speak to customer support'),
      'transcribe: succeeds when using aws credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'transcribe\' test - deepgram', async(t) => {
  if (!DEEPGRAM_API_KEY ) {
    t.pass('skipping deepgram tests');
    return t.end();
  }
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);
    // GIVEN
    let verbs = [
      {
        "verb": "transcribe",
        "recognizer": {
          "vendor": "deepgram",
          "hints": ["customer support", "sales", "human resources", "HR"],
          "deepgramOptions": {
            "apiKey": DEEPGRAM_API_KEY
          }
        },
        "transcriptionHook": "/transcriptionHook"
      }
    ];
    let from = "gather_success";
    provisionCallHook(from, verbs);
    // THEN
    await sippUac('uac-gather-account-creds-success.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    t.ok(obj.body.speech.alternatives[0].transcript.toLowerCase().includes('like to speak to customer support'),
      'transcribe: succeeds when using deepgram credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'transcribe\' test - soniox', async(t) => {
  if (!SONIOX_API_KEY ) {
    t.pass('skipping soniox tests');
    return t.end();
  }
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);
    // GIVEN
    let verbs = [
      {
        "verb": "transcribe",
        "recognizer": {
          "vendor": "soniox",
          "hints": ["customer support", "sales", "human resources", "HR"],
          "deepgramOptions": {
            "apiKey": SONIOX_API_KEY
          }
        },
        "transcriptionHook": "/transcriptionHook"
      }
    ];
    let from = "gather_success";
    provisionCallHook(from, verbs);
    // THEN
    await sippUac('uac-gather-account-creds-success.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    //console.log(JSON.stringify(obj));
    t.ok(obj.body.speech.alternatives[0].transcript.toLowerCase().startsWith('i\'d like to speak to customer support'),
      'transcribe: succeeds when using soniox credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});