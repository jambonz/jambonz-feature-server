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

test('\'play\' tests single link in plain text', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    const verbs = [
      {
        verb: 'play',
        url: 'https://example.com/example.mp3'
      }
    ];

    const from = 'play_single_link';
    provisionCallHook(from, verbs)

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

test('\'play\' tests multi links in array', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    const verbs = [
      {
        verb: 'play',
        url: ['https://example.com/example.mp3', 'https://example.com/example.mp3']
      }
    ];

    const from = 'play_multi_links_in_array';
    provisionCallHook(from, verbs)

    // THEN
    await sippUac('uac-success-received-bye.xml', '172.38.0.10', from);
    t.pass('play: succeeds when using links in array');
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'play\' tests single link in conference', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    const from = 'play_single_link_in_conference';
    const waitHookVerbs = [
      {
        verb: 'play',
        url: 'https://example.com/example.mp3'
      }
    ];

    const verbs = [
      {
        verb: 'conference',
        name: `${from}`,
        beep: true,
        "startConferenceOnEnter": false,
        waitHook: `/customHook`
      }
    ];
    provisionCustomHook(from, waitHookVerbs)
    provisionCallHook(from, verbs)

    // THEN
    await sippUac('uac-success-send-bye.xml', '172.38.0.10', from);
    t.pass('play: succeeds when using in conference as single link');
    // Make sure that waitHook is called and success
    await getJSON(`http:127.0.0.1:3100/lastRequest/${from}_customHook`)
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'play\' tests multi links in array in conference', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    const from = 'play_multi_links_in_conference';
    const waitHookVerbs = [
      {
        verb: 'play',
        url: ['https://example.com/example.mp3', 'https://example.com/example.mp3']
      }
    ];

    const verbs = [
      {
        verb: 'conference',
        name: `${from}`,
        beep: true,
        "startConferenceOnEnter": false,
        waitHook: `/customHook`
      }
    ];
    provisionCustomHook(from, waitHookVerbs)
    provisionCallHook(from, verbs)

    // THEN
    await sippUac('uac-success-send-bye.xml', '172.38.0.10', from);
    t.pass('play: succeeds when using in conference with multi links');
    // Make sure that waitHook is called and success
    await getJSON(`http:127.0.0.1:3100/lastRequest/${from}_customHook`)
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'play\' tests with seekOffset and actionHook', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    const verbs = [
      {
        verb: 'play',
        url: {
          url: 'https://example.com/example.mp3',
          seekOffset: 1,
          timeoutSecs: 2
        },
        actionHook: '/customHook'
      }
    ];

    const waitHookVerbs = [];

    const from = 'play_action_hook';
    provisionCallHook(from, verbs)
    provisionCustomHook(from, waitHookVerbs)

    // THEN
    await sippUac('uac-success-received-bye.xml', '172.38.0.10', from);
    t.pass('play: succeeds');
    const obj  = await getJSON(`http:127.0.0.1:3100/lastRequest/${from}_customHook`)
    t.ok(obj.body.reason === "playCompleted", "play: actionHook success received")
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
