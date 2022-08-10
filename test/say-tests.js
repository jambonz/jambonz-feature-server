const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const clearModule = require('clear-module');
const provisionCallHook = require('./utils')

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

    // GIVEN
    let verbs = [
      {
        "verb": "say",
        "text": "hello"
      }
    ];

    let from = "say_test_success";
    provisionCallHook(from, verbs)

    // THEN
    await sippUac('uac-success-received-bye.xml', '172.38.0.10', from);
    t.pass('say: succeeds when using using account credentials');
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
