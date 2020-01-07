const test = require('blue-tape');
const { output, sippUac } = require('./sipp')('test_sbc-inbound');
const debug = require('debug')('drachtio:sbc-inbound');
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

test('incoming call tests', (t) => {
  const {srf} = require('../app');

  connect(srf)
    .then(() => {
      return sippUac('uac-pcap-carrier-success.xml', '172.38.0.20');
    })
    .then(() => {
      return t.pass('incoming call from carrier completed successfully');
    })
    .then(() => {
      return sippUac('uac-pcap-device-success.xml', '172.38.0.30');
    })
    .then(() => {
      return t.pass('incoming call from authenticated device completed successfully');
    })
    .then(() => {
      return sippUac('uac-device-unknown-user.xml', '172.38.0.30');
    })
    .then(() => {
      return t.pass('unknown user is rejected with a 403');
    })
    .then(() => {
      return sippUac('uac-device-unknown-realm.xml', '172.38.0.30');
    })
    .then(() => {
      return t.pass('unknown realm is rejected with a 403');
    })
    .then(() => {
      return sippUac('uac-device-invalid-password.xml', '172.38.0.30');
    })
    .then(() => {
      return t.pass('invalid password for valid user is rejected with a 403');
    })
    .then(() => {
      return sippUac('uac-pcap-device-success-in-dialog-request.xml', '172.38.0.30');
    })
    .then(() => {
      return t.pass('handles in-dialog requests');
    })
    .then(() => {
      srf.disconnect();
      t.end();
      return;
    })
    .catch((err) => {
      console.log(`error received: ${err}`);
      if (srf) srf.disconnect();
      t.error(err);
    });
});
