const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
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

test('basic webhook tests', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');
  const provisionCallHook = require('./utils')

  try {
    await connect(srf);
    const verbs = [
      {
        verb: 'sip:decline',
        status: 603,
        reason: 'Gone Fishin',
        headers: {
          'Retry-After': 300
        }  
      }
    ];

    const from = 'sip_decline_test_success';
    provisionCallHook(from, verbs)

    await sippUac('uac-expect-603.xml', '172.38.0.10', from);
    t.pass('webhook successfully declines call');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
