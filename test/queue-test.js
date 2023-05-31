const test = require('tape');
const { sippUac } = require('./sipp')('test_fs');
const clearModule = require('clear-module');
const {provisionCallHook, provisionActionHook} = require('./utils');
const bent = require('bent');
const getJSON = bent('json');

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

const sleepFor = (ms) => new Promise((resolve) => setTimeout(() => resolve(), ms));

test('\'enqueue-dequeue\' tests', async(t) => {

  clearModule.all();
  const {srf, disconnect} = require('../app');
  try {
    await connect(srf);
    // GIVEN
    const verbs = [
      {
        verb: 'leave'
      }
    ];

    const verbs2 = [
      {
        verb: 'dequeue',
        name: 'support'
      }
    ];

    const actionVerbs = [
      {
        verb: 'play',
        url: 'silence_stream://1000',
        earlyMedia: true
      }
    ];

    const from = 'enqueue_success';
    await provisionCallHook(from, verbs);
    await provisionActionHook(from, actionVerbs)

    const from2 = 'dequeue_success';
    await provisionCallHook(from2, verbs2);
    

    // THEN
    const p1 = sippUac('uac-success-received-bye.xml', '172.38.0.10', from);

    await sleepFor(1000);

    const p2 = sippUac('uac-success-send-bye.xml', '172.38.0.11', from2);
    await Promise.all([p1, p2]);
    const obj  = await getJSON(`http:127.0.0.1:3100/lastRequest/${from}_actionHook`);
    t.ok(obj.body.queue_result === 'bridged');
    t.pass('enqueue-dequeue: succeeds connect');
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});