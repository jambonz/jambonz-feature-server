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

test('sending SIP in-dialog requests tests', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);
    //GIVEN
    let verbs = [
      {
        "verb": "say",
        "text": "hello"
      },
      {
        "verb": "sip:request",
        "method": "info",
        "headers": {
          "Content-Type": "application/text"
        },
        "body": "here I am ",
        "actionHook": "/actionHook"
      }
    ];
    let from = "sip_indialog_test";
    provisionCallHook(from, verbs);
    // THEN
    await sippUac('uac-send-info-during-dialog.xml', '172.38.0.10', from);
    const obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    t.ok(obj.body.sip_status === 200, 'successfully sent SIP INFO');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
