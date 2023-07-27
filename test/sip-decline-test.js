const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const clearModule = require('clear-module');
const {provisionCallHook} = require('./utils');
const bent = require('bent');
const getJSON = bent('json');

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


test('\'sip:decline\' tests', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    const verbs = [
      {
        "verb": "sip:decline",
        "status": 480,
        "reason": "Gone Fishing",
        "headers" : {
          "Retry-After": 1800
        }
      }
      
    ];

    const from = 'sip_delecine_success';
    await provisionCallHook(from, verbs)

    // THEN
    await sippUac('uac-invite-expect-480.xml', '172.38.0.10', from);

    let obj = await getJSON(`http:127.0.0.1:3100/requests/${from}_callStatus`);
    t.ok(obj.map((o) => o.body.call_status).includes('failed'),
      'sip:decline: status callback successfully executed');
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});