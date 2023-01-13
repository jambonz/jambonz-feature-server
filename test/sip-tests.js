const test = require('tape');
const { sippUac } = require('./sipp')('test_sbc-inbound');

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
      return sippUac('uac-refer-no-notify.xml', '172.38.0.30');
    })
    .then(() => {
      return t.pass('handles sip:refer where we get 202 but no NOTIFY');
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
