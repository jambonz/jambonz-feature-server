const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const bent = require('bent');
const getJSON = bent('json')
const clearModule = require('clear-module');
const {provisionCallHook} = require('./utils')

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
  if (!process.env.GCP_JSON_KEY) {
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
  if (!process.env.MICROSOFT_REGION || !process.env.MICROSOFT_API_KEY) {
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
  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
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
  if (!process.env.DEEPGRAM_API_KEY ) {
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
          "vendor": "aws",
          "hints": ["customer support", "sales", "human resources", "HR"],
          "deepgramOptions": {
            "apiKey": process.env.DEEPGRAM_API_KEY
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
    t.ok(obj.body.speech.alternatives[0].transcript.toLowerCase().startsWith('i\'d like to speak to customer support'),
      'transcribe: succeeds when using deepgram credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});