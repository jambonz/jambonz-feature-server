const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const bent = require('bent');
const getJSON = bent('json')
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

test('\'config: listen\'', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');
  try {
    await connect(srf);

    // GIVEN
    const from = "config_listen_success";
    let verbs = [
      {
        "verb": "config",
        "listen": {
          "enable": true,
          "url": `ws://172.38.0.60:3000/${from}`
        }
      },
      {
        "verb": "pause",
        "length": 5
      }
    ];

    provisionCallHook(from, verbs);

    // THEN
    await sippUac('uac-gather-account-creds-success-send-bye.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/ws_packet_count/${from}`);
    t.pass('config: successfully started background listen');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'config: listen - stop\'', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');
  try {
    await connect(srf);

    // GIVEN
    const from = "config_listen_success";
    let verbs = [
      {
        "verb": "config",
        "listen": {
          "enable": true,
          "url": `ws://172.38.0.60:3000/${from}`
        }
      },
      {
        "verb": "pause",
        "length": 1
      },
      {
        "verb": "config",
        "listen": {
          "enable": false
        }
      },
      {
        "verb": "pause",
        "length": 3
      }
    ];

    provisionCallHook(from, verbs);

    // THEN
    await sippUac('uac-gather-account-creds-success-send-bye.xml', '172.38.0.10', from);
    let obj = await getJSON(`http://127.0.0.1:3100/ws_packet_count/${from}`);
    t.pass('config: successfully started then stopped background listen');

    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
