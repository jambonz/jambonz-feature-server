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

test('\'say\' tests', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);
    await sippUac('uac-say-account-creds-success.xml', '172.38.0.10');
    t.pass('say: succeeds when using using account credentials');
  
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
