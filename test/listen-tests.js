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

test('\'listen\'', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');
  try {
    await connect(srf);

    // GIVEN
    let from = "listen_success";
    let verbs = [
      {
        "verb": "listen",
        "url": `ws://172.38.0.60:3100/${from}`,
        "mixType" : "mixed",
        "timeout": 10
      },
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

    provisionCallHook(from, verbs);

    // THEN
    await sippUac('uac-gather-account-creds-success.xml', '172.38.0.10', from);
    // let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    // //console.log(JSON.stringify(obj));
    // t.ok(obj.body.speech.alternatives[0].transcript.toLowerCase() === 'i\'d like to speak to customer support',
    //   'gather: succeeds when using default (google) credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});