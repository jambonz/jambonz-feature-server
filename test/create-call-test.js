const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const bent = require('bent');
const getJSON = bent('json')
const clearModule = require('clear-module');
const HttpRequestor = require('../lib/utils/http-requestor');


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
    let account_sid = '622f62e4-303a-49f2-bbe0-eb1e1714e37a'
    const post = bent('http://127.0.0.1:3000/', 'POST', 'json', 201)
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
      }})
    await sippUac('uas-timeout-cancel.xml', '172.38.0.10');
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
