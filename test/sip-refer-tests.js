const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const clearModule = require('clear-module');
const {provisionCallHook, provisionCustomHook, provisionActionHook} = require('./utils')
const bent = require('bent');
const getJSON = bent('json')

const sleepFor = async(ms) => new Promise(resolve => setTimeout(resolve, ms));

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

test('\'refer\' tests w/202 and NOTIFY', {timeout: 25000}, async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    const verbs = [
      {
        verb: 'say',
        text: 'silence_stream://100'
      },
      {
        verb: 'sip:refer',
        referTo: '123456',
        actionHook: '/actionHook'
      }
    ];
    const noVerbs = [];

    const from = 'refer_with_notify';
    provisionCallHook(from, verbs);
    provisionActionHook(from, noVerbs)

    // THEN
    await sippUac('uac-refer-with-notify.xml', '172.38.0.10', from);
    t.pass('refer: successfully received 202 Accepted');
    await sleepFor(1000);
    const obj  = await getJSON(`http:127.0.0.1:3100/lastRequest/${from}_actionHook`);
    t.ok(obj.body.final_referred_call_status === 200, 'refer: successfully received NOTIFY with 200 OK');
    //console.log(`obj: ${JSON.stringify(obj)}`);
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'refer\' tests w/202 but no NOTIFY', {timeout: 25000}, async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    const verbs = [
      {
        verb: 'say',
        text: 'silence_stream://100'
      },
      {
        verb: 'sip:refer',
        referTo: '123456',
        actionHook: '/actionHook'
      }
    ];
    const noVerbs = [];

    const from = 'refer_no_notify';
    provisionCallHook(from, verbs);
    provisionActionHook(from, noVerbs)

    // THEN
    await sippUac('uac-refer-no-notify.xml', '172.38.0.10', from);
    t.pass('refer: successfully received 202 Accepted w/o NOTIFY');
    await sleepFor(17000);
    const obj  = await getJSON(`http:127.0.0.1:3100/lastRequest/${from}_actionHook`);
    console.log(`obj: ${JSON.stringify(obj)}`);
    t.ok(obj.body.refer_status === 202, 'refer: successfully timed out and reported 202');
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
