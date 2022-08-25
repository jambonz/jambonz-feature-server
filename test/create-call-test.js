const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const bent = require('bent');
const clearModule = require('clear-module');
const {provisionCallHook} = require('./utils')
const getJSON = bent('json')

const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

test('test create-call timeout', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // give UAS app time to come up
    const p = sippUac('uas-timeout-cancel.xml', '172.38.0.10');
    await waitFor(1000);

    // GIVEN
    let account_sid = '622f62e4-303a-49f2-bbe0-eb1e1714e37a';
    const post = bent('http://127.0.0.1:3000/', 'POST', 'json', 201);
    post('v1/createCall', {
      'account_sid':account_sid,
      'timeout': 1,
      "call_hook": {
        "url": "https://public-apps.jambonz.us/hello-world",
        "method": "POST"
      },
      "from": "15083718299",
      "to": {
        "type": "phone",
        "number": "15583084809"
      }});
    //THEN
    await p;
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('test create-call call-hook basic authentication', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);


    // GIVEN
    let from = 'call_hook_basic_authentication';
    let account_sid = '622f62e4-303a-49f2-bbe0-eb1e1714e37a';

    // Give UAS app time to come up
    const p = sippUac('uas.xml', '172.38.0.10', from);
    await waitFor(1000);

    const post = bent('http://127.0.0.1:3000/', 'POST', 'json', 201);
    post('v1/createCall', {
      'account_sid':account_sid,
      "call_hook": {
        "url": "http://127.0.0.1:3100/",
        "method": "POST",
        "username": "username",
        "password": "password"
      },
      "from": from,
      "to": {
        "type": "phone",
        "number": "15583084809"
      }});

    let verbs = [
      {
        "verb": "say",
        "text": "hello"
      }
    ];
    provisionCallHook(from, verbs);
    //THEN
    await p;

    let obj = await getJSON(`http:127.0.0.1:3100/lastRequest/${from}`)
    t.ok(obj.headers.Authorization = 'Basic dXNlcm5hbWU6cGFzc3dvcmQ=',
      'create-call: call-hook contains basic authentication header');
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
