const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const clearModule = require('clear-module');
const {provisionCallHook} = require('./utils')
const opts = {
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;},
  level: process.env.JAMBONES_LOGLEVEL || 'info'
};
const logger = require('pino')(opts);
const { queryAlerts } = require('@jambonz/time-series')(
  logger, process.env.JAMBONES_TIME_SERIES_HOST
);

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

test('invalid jambonz json create alert tests', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    // Invalid json array
    const verbs = {
      verb: 'say',
      text: 'hello'
    };

    const from = 'invalid_json_create_alert';
    provisionCallHook(from, verbs)

    // THEN
    await sippUac('uac-invite-expect-480.xml', '172.38.0.10', from);
    // sleep testcase for more than 7 second to wait alert pushed to database.
    await sleep(8000);
    const data = await queryAlerts(
      {account_sid: 'bb845d4b-83a9-4cde-a6e9-50f3743bab3f', page: 1, page_size: 25, days: 7});
    let checked = false;
    for (let i = 0; i < data.total; i++) {
      checked = data.data[i].message === 'malformed jambonz payload: must be array'
    }
    t.ok(checked, 'alert is raised as expected');
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
