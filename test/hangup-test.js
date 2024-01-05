const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const clearModule = require('clear-module');
const {provisionCallHook, provisionCustomHook} = require('./utils')
const bent = require('bent');
const getJSON = bent('json')

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

test('\'hangup\' custom headers', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    const verbs = [
      {
        verb: 'play',
        url: 'https://example.com/example.mp3'
      },
      {
        "verb": "hangup",
        "headers": {
          "X-Reason" : "maximum call duration exceeded"
        }
      }
    ];

    const from = 'hangup_custom_headers';
    await provisionCallHook(from, verbs)

    // THEN
    await sippUac('uac-success-received-bye.xml', '172.38.0.10', from);
    t.pass('play: succeeds when using single link');
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});