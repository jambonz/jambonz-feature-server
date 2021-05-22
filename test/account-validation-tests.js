const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');

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

test('account validation tests', async(t) => {
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);
    await sippUac('uac-expect-500.xml', '172.38.0.10');
    t.pass('rejected INVITE without X-Account-Sid header');
    await sippUac('uac-invalid-account-expect-503.xml', '172.38.0.10');
    t.pass('rejected INVITE with invalid X-Account-Sid header');
    await sippUac('uac-inactive-account-expect-503.xml', '172.38.0.10');
    t.pass('rejected INVITE from inactive account');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
