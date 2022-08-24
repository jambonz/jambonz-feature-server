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

test('\'gather\' and \'transcribe\' tests', async(t) => {
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
    t.ok(obj.body.speech.alternatives[0].transcript = 'I\'d like to speak to customer support',
      'gather: succeeds when using account credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
