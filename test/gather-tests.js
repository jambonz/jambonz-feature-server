const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const exec = require('child_process').exec ;
const bent = require('bent');
const getJSON = bent('json')
const clearModule = require('clear-module');

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
    await sippUac('uac-gather-account-creds-success.xml', '172.38.0.10');
    let obj = await getJSON('http://127.0.0.1:3102/actionHook');
    t.ok(obj.speech.alternatives[0].transcript = 'I\'d like to speak to customer support',
      'gather: succeeds when using account credentials');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
