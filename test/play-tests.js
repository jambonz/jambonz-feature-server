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
        url: 'silence_stream://5000',
        seekOffset: 8000,
        timeoutSecs: 2,
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
    const obj  = await getJSON(`http:127.0.0.1:3100/lastRequest/${from}_customHook`);
    const seconds = parseInt(obj.body.playback_seconds);
    const milliseconds = parseInt(obj.body.playback_milliseconds);
    const lastOffsetPos = parseInt(obj.body.playback_last_offset_pos);
    //console.log({obj}, 'lastRequest');
    t.ok(obj.body.reason === "playCompleted", "play: actionHook success received");
    t.ok(seconds === 2, "playback_seconds: actionHook success received");
    t.ok(milliseconds === 2048, "playback_milliseconds: actionHook success received");
    t.ok(lastOffsetPos > 15500 && lastOffsetPos < 16500, "playback_last_offset_pos: actionHook success received")
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'play\' tests with earlymedia', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);

    // GIVEN
    const verbs = [
      {
        verb: 'play',
        url: 'silence_stream://5000',
        earlyMedia: true
      }
    ];

    const from = 'play_early_media';
    provisionCallHook(from, verbs)

    // THEN
    await sippUac('uac-invite-expect-183-cancel.xml', '172.38.0.10', from);
    const obj  = await getJSON(`http:127.0.0.1:3100/lastRequest/${from}_callStatus`);
    t.ok(obj.body.sip_status === 487, "play: actionHook success received");
    t.ok(obj.body.sip_reason === 'Request Terminated', "play: actionHook success received");
    t.ok(obj.body.call_termination_by === 'caller', "play: actionHook success received");
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});

test('\'play\' tests with initial app_json', async(t) => {
  clearModule.all();
  const {srf, disconnect} = require('../app');

  try {
    await connect(srf);
    const from = 'play_initial_app_json';

    // THEN
    await sippUac('uac-success-received-bye.xml', '172.38.0.10', from, "16174000007");
    t.pass('application can use app_json for initial instructions');
    disconnect();
  } catch (err) {
    console.log(`error received: ${err}`);
    disconnect();
    t.error(err);
  }
});
