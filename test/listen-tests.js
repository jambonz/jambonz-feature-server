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

test('\'listen-success\'', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');
  try {
    await connect(srf);

    // GIVEN
    const from = "listen_success";
    let verbs = [
      {
        "verb": "listen",
        "url": `ws://172.38.0.60:3000/${from}`,
        "mixType" : "mono",
        "actionHook": "/actionHook",
        "playBeep": true,
      }
    ];

    provisionCallHook(from, verbs);

    // THEN
    await sippUac('uac-gather-account-creds-success-send-bye.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/ws_packet_count/${from}`);
    t.ok(38000 <= obj.count, 'listen: success incoming call audio');

    obj = await getJSON(`http://127.0.0.1:3100/ws_metadata/${from}`);
    t.ok(obj.metadata.from === from && obj.metadata.sampleRate === 8000, 'listen: success metadata');

    obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    t.ok(obj.body.from === from,
      'listen: succeeds actionHook');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'listen-maxLength\'', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');
  try {
    await connect(srf);

    // GIVEN
    let from = "listen_timeout";
    let verbs = [
      {
        "verb": "listen",
        "url": `ws://172.38.0.60:3000/${from}`,
        "mixType" : "mixed",
        "timeout": 2,
        "maxLength": 2
      }
    ];

    provisionCallHook(from, verbs);

    // THEN
    await sippUac('uac-gather-account-creds-success.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/ws_packet_count/${from}`);
    t.ok(30000 <= obj.count, 'listen: success maxLength incoming call audio');

    obj = await getJSON(`http://127.0.0.1:3100/ws_metadata/${from}`);
    t.ok(obj.metadata.from === from && obj.metadata.sampleRate === 8000, 'listen: success maxLength metadata');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'listen-pause-resume\'', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');
  try {
    await connect(srf);

    // GIVEN
    let from = "listen_timeout";
    let verbs = [
      {
        "verb": "listen",
        "url": `ws://172.38.0.60:3000/${from}`,
        "mixType" : "mixed"
      }
    ];

    provisionCallHook(from, verbs);

    // THEN
    const p = sippUac('uac-gather-account-creds-success.xml', '172.38.0.10', from);
    await new Promise(r => setTimeout(r, 2000));

    let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}`);
    const callSid = obj.body.call_sid;

    // GIVEN
    // Pause listen
    let post = bent('http://127.0.0.1:3000/', 'POST', 202);
    await post(`v1/updateCall/${callSid}`, {
        "listen_status": "pause"
    });

    await new Promise(r => setTimeout(r, 2000));

    // Resume listen
    post = bent('http://127.0.0.1:3000/', 'POST', 202);
    await post(`v1/updateCall/${callSid}`, {
        "listen_status": "resume"
    });

    // turn off the call
    post = bent('http://127.0.0.1:3000/', 'POST', 202);
    await post(`v1/updateCall/${callSid}`, {
        "call_status": "completed"
    });

    await p;
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});