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
        "url": "https://public-apps.jambonz.cloud/hello-world",
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
        "verb": "pause",
        "length": 1
      }
    ];
    await provisionCallHook(from, verbs);
    //THEN
    await p;

    let obj = await getJSON(`http:127.0.0.1:3100/lastRequest/${from}`)
    t.ok(obj.headers.Authorization = 'Basic dXNlcm5hbWU6cGFzc3dvcmQ=',
      'create-call: call-hook contains basic authentication header');
    t.ok(obj.headers['user-agent'] = 'jambonz',
    'create-call: call-hook contains user-agent header');
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('test create-call amd', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);


    // GIVEN
    let from = 'create-call-amd';
    let account_sid = 'bb845d4b-83a9-4cde-a6e9-50f3743bab3f';

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
      },
      "amd": {
        "actionHook": "/actionHook"
      },
      "speech_recognizer_vendor": "google",
      "speech_recognizer_language": "en"
    });

    let verbs = [
      {
        "verb": "pause",
        "length": 7
      }
    ];
    await provisionCallHook(from, verbs);
    //THEN
    await p;

    let obj = await getJSON(`http:127.0.0.1:3100/lastRequest/${from}_actionHook`)
    t.ok(obj.body.type = 'amd_no_speech_detected',
      'create-call: AMD detected');
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('test create-call app_json', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);


    // GIVEN
    let from = 'create-call-app-json';
    let account_sid = 'bb845d4b-83a9-4cde-a6e9-50f3743bab3f';

    // Give UAS app time to come up
    const p = sippUac('uas.xml', '172.38.0.10', from);
    await waitFor(1000);

    const app_json = `[
      {
        "verb": "pause",
        "length": 7
      }
    ]`;

    const post = bent('http://127.0.0.1:3000/', 'POST', 'json', 201);
    post('v1/createCall', {
      'account_sid':account_sid,
      "call_hook": {
        "url": "http://127.0.0.1:3100/",
        "method": "POST",
        "username": "username",
        "password": "password"
      },
      app_json,
      "from": from,
      "to": {
        "type": "phone",
        "number": "15583084809"
      },
      "amd": {
        "actionHook": "/actionHook"
      },
      "speech_recognizer_vendor": "google",
      "speech_recognizer_language": "en"
    });

    //THEN
    await p;

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('test create-call timeLimit', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);


    // GIVEN
    let from = 'create-call-app-json';
    let account_sid = 'bb845d4b-83a9-4cde-a6e9-50f3743bab3f';

    // Give UAS app time to come up
    const p = sippUac('uas.xml', '172.38.0.10', from);
    await waitFor(1000);

    const startTime = Date.now();

    const app_json = `[
      {
        "verb": "pause",
        "length": 7
      }
    ]`;

    const post = bent('http://127.0.0.1:3000/', 'POST', 'json', 201);
    post('v1/createCall', {
      'account_sid':account_sid,
      "call_hook": {
        "url": "http://127.0.0.1:3100/",
        "method": "POST",
        "username": "username",
        "password": "password"
      },
      app_json,
      "from": from,
      "to": {
        "type": "phone",
        "number": "15583084809"
      },
      "timeLimit": 1,
      "speech_recognizer_vendor": "google",
      "speech_recognizer_language": "en"
    });

    //THEN
    await p;
    const endTime = Date.now();

    t.ok(endTime - startTime < 2000, 'create-call: timeLimit is respected');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
