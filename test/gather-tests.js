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

test('\'gather\' test - google', async(t) => {
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
        "verb": "gather",
        "input": ["speech"],
        "recognizer": {
          "vendor": "google",
          "hints": ["customer support", "sales", "human resources", "HR"]
        },
        "timeout": 10,
        "actionHook": "/actionHook"
      }
    ];
    let from = "gather_success";
    provisionCallHook(from, verbs);
    // THEN
    await sippUac('uac-gather-account-creds-success.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    //console.log(JSON.stringify(obj));
    t.ok(obj.body.speech.alternatives[0].transcript.toLowerCase().startsWith('i\'d like to speak to customer support'),
      'gather: succeeds when using google credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'gather\' test - default (google)', async(t) => {
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
        "verb": "gather",
        "input": ["speech"],
        "timeout": 10,
        "actionHook": "/actionHook"
      }
    ];
    let from = "gather_success";
    provisionCallHook(from, verbs);
    // THEN
    await sippUac('uac-gather-account-creds-success.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    //console.log(JSON.stringify(obj));
    t.ok(obj.body.speech.alternatives[0].transcript.toLowerCase() === 'i\'d like to speak to customer support',
      'gather: succeeds when using default (google) credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'gather\' test - microsoft', async(t) => {
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
        "verb": "gather",
        "input": ["speech"],
        "recognizer": {
          "vendor": "microsoft",
          "hints": ["customer support", "sales", "human resources", "HR"]
        },
        "timeout": 10,
        "actionHook": "/actionHook"
      }
    ];
    let from = "gather_success";
    provisionCallHook(from, verbs);
    // THEN
    await sippUac('uac-gather-account-creds-success.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    //console.log(JSON.stringify(obj));
    t.ok(obj.body.speech.alternatives[0].transcript.toLowerCase().startsWith('i\'d like to speak to customer support'),
      'gather: succeeds when using  microsoft credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'gather\' test - aws', async(t) => {
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
        "verb": "gather",
        "input": ["speech"],
        "recognizer": {
          "vendor": "aws",
          "hints": ["customer support", "sales", "human resources", "HR"]
        },
        "timeout": 10,
        "actionHook": "/actionHook"
      }
    ];
    let from = "gather_success";
    provisionCallHook(from, verbs);
    // THEN
    await sippUac('uac-gather-account-creds-success.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    //console.log(JSON.stringify(obj));
    t.ok(obj.body.speech.alternatives[0].transcript.toLowerCase().startsWith('i\'d like to speak to customer support'),
      'gather: succeeds when using aws credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'gather\' test - deepgram', async(t) => {
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
        "verb": "gather",
        "input": ["speech"],
        "recognizer": {
          "vendor": "deepgram",
          "hints": ["customer support", "sales", "human resources", "HR"],
          "deepgramOptions": {
            "apiKey": process.env.DEEPGRAM_API_KEY
          }
        },
        "timeout": 10,
        "actionHook": "/actionHook"
      }
    ];
    let from = "gather_success";
    provisionCallHook(from, verbs);
    // THEN
    await sippUac('uac-gather-account-creds-success.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    //console.log(JSON.stringify(obj));
    t.ok(obj.body.speech.alternatives[0].transcript.toLowerCase().startsWith('i\'d like to speak to customer support'),
      'gather: succeeds when using  deepgram credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
