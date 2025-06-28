const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const bent = require('bent');
const getJSON = bent('json')
const clearModule = require('clear-module');
const {provisionCallHook} = require('./utils');
const { sleepFor } = require('../lib/utils/helpers');

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

test('when parent leg recvs REFER it should end the dial after adulting child leg', async(t) => {
    clearModule.all();
    const {srf, disconnect} = require('../app');
    try {
      await connect(srf);
      // wait for fs connected to drachtio server.
      await sleepFor(1000);
      
      // GIVEN
      const from = "dial_refer_handler";
      let verbs = [
        {
          "verb": "dial",
          "callerId": from,
          "actionHook": "/actionHook",
          "referHook": "/referHook",
          "anchorMedia": true,
          "target": [
              {
                  "type": "phone",
                  "number": "15083084809"
              }
          ]
        }
      ];
  
      await provisionCallHook(from, verbs);
  
      // THEN
      //const p = sippUac('uas-dial.xml', '172.38.0.10', undefined, undefined, 2);
      const p = sippUac('uas-dial-refer.xml', '172.38.0.10', undefined, undefined, 2);
      await sleepFor(1000);
  
      let account_sid = '622f62e4-303a-49f2-bbe0-eb1e1714e37a';
  
      let post = bent('http://127.0.0.1:3000/', 'POST', 'json', 201);
      post('v1/createCall', {
        'account_sid':account_sid,
        "call_hook": {
          "url": "http://127.0.0.1:3100/",
          "method": "POST",
        },
        "from": from,
        "to": {
          "type": "phone",
          "number": "15583084808"
      }});
  
      await p;
  
      // Verify that the referHook was called
      const obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_referHook`);
      t.ok(obj.body.from === from,
        'dial-refer-handler: referHook was called with correct from');
      t.ok(obj.body.refer_details && obj.body.refer_details.sip_refer_to,
        'dial-refer-handler: refer_details included in referHook');
      t.ok(obj.body.refer_details.refer_to_user === '+15551234567',
        'dial-refer-handler: refer_to_user correctly parsed');
      t.ok(obj.body.refer_details.referring_call_sid,
        'dial-refer-handler: referring_call_sid included');
      t.ok(obj.body.refer_details.referred_call_sid,
        'dial-refer-handler: referred_call_sid included');
  
      disconnect();
    } catch (err) {
      console.log(`error received: ${err}`);
      disconnect();
      t.error(err);
    }
});