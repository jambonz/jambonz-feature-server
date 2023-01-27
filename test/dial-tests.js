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

test('\'dial-phone\'', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');
  try {
    await connect(srf);
    // wait for fs connected to drachtio server.
    await new Promise(r => setTimeout(r, 1000));

    // GIVEN
    const from = "dial_success";
    let verbs = [
      {
        "verb": "dial",
        "callerId": from,
        "actionHook": "/actionHook",
        "timeLimit": 5,
        "target": [
            {
                "type": "phone",
                "number": "15083084809"
            }
        ]
      }
    ];

    provisionCallHook(from, verbs);

    // THEN
    const p = sippUac('uas-dial.xml', '172.38.0.10', undefined, undefined, 2);

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

    obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
    t.ok(obj.body.from === from,
      'dial: succeeds actionHook');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});


test('\'dial-sip\'', async(t) => {
    clearModule.all();
    const {srf, disconnect} = require('../app');
    try {
      await connect(srf);
      // wait for fs connected to drachtio server.
      await new Promise(r => setTimeout(r, 1000));
      // GIVEN
      const from = "dial_sip";
      let verbs = [
        {
          "verb": "dial",
          "callerId": from,
          "actionHook": "/actionHook",
          "dtmfCapture":["*2", "*3"],
          "target": [
              {
                  "type": "sip",
                  "sipUri": "sip:15083084809@jambonz.com"
              }
          ]
        }
      ];
  
      provisionCallHook(from, verbs);
  
      // THEN
      const p = sippUac('uas-dial.xml', '172.38.0.10', undefined, undefined, 2);
  
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
  
      await new Promise(r => setTimeout(r, 2000));
  
      let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}`);
      const callSid = obj.body.call_sid;
  
      post = bent('http://127.0.0.1:3000/', 'POST', 202);
      await post(`v1/updateCall/${callSid}`, {
          "call_status": "completed"
      });
  
      await p;
  
      obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
      t.ok(obj.body.from === from,
        'dial: succeeds actionHook');
  
      disconnect();
    } catch (err) {
      console.log(`error received: ${err}`);
      disconnect();
      t.error(err);
    }
});

test('\'dial-user\'', async(t) => {
    clearModule.all();
    const {srf, disconnect} = require('../app');
    try {
      await connect(srf);
      // wait for fs connected to drachtio server.
      await new Promise(r => setTimeout(r, 1000));
      // GIVEN
      const from = "dial_user";
      let verbs = [
        {
          "verb": "dial",
          "callerId": from,
          "actionHook": "/actionHook",
          "target": [
              {
                  "type": "user",
                  "name": "user110@jambonz.com"
              }
          ]
        }
      ];
  
      provisionCallHook(from, verbs);
  
      // THEN
      const p = sippUac('uas-dial.xml', '172.38.0.10', undefined, undefined, 2);
  
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
  
      await new Promise(r => setTimeout(r, 2000));
  
      let obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}`);
      const callSid = obj.body.call_sid;
  
      post = bent('http://127.0.0.1:3000/', 'POST', 202);
      await post(`v1/updateCall/${callSid}`, {
          "call_status": "completed"
      });
  
      await p;
  
      obj = await getJSON(`http://127.0.0.1:3100/lastRequest/${from}_actionHook`);
      t.ok(obj.body.from === from,
        'dial: succeeds actionHook');
  
      disconnect();
    } catch (err) {
      console.log(`error received: ${err}`);
      disconnect();
      t.error(err);
    }
});