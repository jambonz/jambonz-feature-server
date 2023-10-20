const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const clearModule = require('clear-module');
const {provisionCallHook} = require('./utils')

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
    const verbs = [
      {
        verb: 'say',
        text: 'hello'
      }
    ];

    const from = 'say_test_success';
    await provisionCallHook(from, verbs)

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

test('\'config\' reset synthesizer tests', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    const verbs = [
      {
        "verb": "config",
        "synthesizer": {
          "vendor": "microsft",
          "voice": "foobar"
        },
      },
      {
        "verb": "config",
        "reset": 'synthesizer',
      },
      {
        verb: 'say',
        text: 'hello'
      }
    ];

    const from = 'say_test_success';
    await provisionCallHook(from, verbs)

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

test('Say verb array test', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    const verbs = [
      {
        "verb": "config",
        "synthesizer": {
          "vendor": "microsft",
          "voice": "foobar"
        },
      },
      {
        "verb": "config",
        "reset": 'synthesizer',
      },
      {
        verb: 'say',
        text: ['hello', 'https://samplelib.com/lib/preview/mp3/sample-3s.mp3']
      }
    ];

    const from = 'say_test_success';
    await provisionCallHook(from, verbs)

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

const {MICROSOFT_CUSTOM_API_KEY, MICROSOFT_DEPLOYMENT_ID, MICROSOFT_CUSTOM_REGION, MICROSOFT_CUSTOM_VOICE} = process.env;
if (MICROSOFT_CUSTOM_API_KEY && MICROSOFT_DEPLOYMENT_ID && MICROSOFT_CUSTOM_REGION && MICROSOFT_CUSTOM_VOICE) {
  test('\'say\' tests - microsoft custom voice', async(t) => {
    clearModule.all();
    const {srf, disconnect} = require('../app');

    try {
      await connect(srf);

      // GIVEN
      const verbs = [
        {
          verb: 'say',
          text: 'hello',
          synthesizer: {
            vendor: 'microsoft',
            voice: MICROSOFT_CUSTOM_VOICE,
            options: {
              deploymentId: MICROSOFT_DEPLOYMENT_ID,
              apiKey: MICROSOFT_CUSTOM_API_KEY,
              region: MICROSOFT_CUSTOM_REGION,
            }
          }
        }
      ];

      const from = 'say_test_success';
      await provisionCallHook(from, verbs)

      // THEN
      await sippUac('uac-success-received-bye.xml', '172.38.0.10', from);
      t.pass('say: succeeds when using microsoft custom voice');
      disconnect();
    } catch (err) {
      console.log(`error received: ${err}`);
      disconnect();
      t.error(err);
    }
  });
}
