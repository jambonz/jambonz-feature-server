const test = require('tape');
const clearModule = require('clear-module');

// ENCRYPTION_SECRET is required when loading the session modules (encrypt-decrypt.js
// hashes it at require time). The npm `test` script sets it; guard here so the file
// can also be run standalone.
process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'foobar';

// The feature is opt-in behind JAMBONES_HOLD_UNHOLD_EVENTS, which lib/config.js
// captures ONCE at load time. When this file runs inside the full suite (test/index.js),
// config.js and the session modules have already been required by earlier tests with the
// flag unset, so simply setting the env var here would be too late. loadWith() sets the
// flag and force-reloads config + the session modules so they re-read it, regardless of
// what loaded them first.
const ORIGINAL_FLAG = process.env.JAMBONES_HOLD_UNHOLD_EVENTS;
function loadWith(value) {
  if (value === undefined) delete process.env.JAMBONES_HOLD_UNHOLD_EVENTS;
  else process.env.JAMBONES_HOLD_UNHOLD_EVENTS = value;
  clearModule('../lib/config');
  clearModule('../lib/session/call-session');
  clearModule('../lib/session/siprec-call-session');
  return {
    CallSession: require('../lib/session/call-session'),
    SipRecCallSession: require('../lib/session/siprec-call-session')
  };
}

// enabled for the behavioural tests
const {CallSession, SipRecCallSession} = loadWith('1');

const noop = () => {};

// A minimal stand-in for a CallSession/SipRecCallSession instance, exposing only
// what _notifyHoldState / _notifySipRecReinvite touch. We invoke the real prototype
// methods against it so the hold-transition logic is exercised without spinning up
// drachtio/freeswitch.
function makeSession(overrides = {}) {
  const emitted = [];
  const hookCalls = [];
  return {
    _onHold: undefined,
    callSid: 'call-sid-abc',
    logger: {info: noop, error: noop, debug: noop},
    sipRequestWithinDialogHook: '/hold-events',
    callInfo: {toJSON: () => ({call_sid: 'call-sid-abc', account_sid: 'acct-sid-xyz'})},
    requestor: {
      request: (type, hook, params) => {
        hookCalls.push({type, hook, params});
        return Promise.resolve();
      }
    },
    emit: (event) => emitted.push(event),
    emitted,
    hookCalls,
    ...overrides
  };
}

const HOLD_SDP = 'v=0\r\no=- 1 1 IN IP4 1.1.1.1\r\ns=-\r\nc=IN IP4 1.1.1.1\r\nt=0 0\r\n' +
  'm=audio 4000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=sendonly\r\n';
const INACTIVE_SDP = HOLD_SDP.replace('a=sendonly', 'a=inactive');
const ACTIVE_SDP = HOLD_SDP.replace('a=sendonly', 'a=sendrecv');

const notifyHoldState = CallSession.prototype._notifyHoldState;
const notifySipRecReinvite = SipRecCallSession.prototype._notifySipRecReinvite;

test('CallSession._notifyHoldState - fires on hold transition', (t) => {
  const s = makeSession();
  notifyHoldState.call(s, {body: HOLD_SDP, headers: {'call-id': 'x'}});

  t.equal(s._onHold, true, 'tracks on-hold state');
  t.deepEqual(s.emitted, ['hold'], 'emits a single "hold" event');
  t.equal(s.hookCalls.length, 1, 'invokes the in-dialog hook once');

  const {type, hook, params} = s.hookCalls[0];
  t.equal(type, 'verb:hook', 'delivered over the task-independent verb:hook channel');
  t.equal(hook, '/hold-events', 'uses the configured sipRequestWithinDialogHook');
  t.equal(params.event, 'hold', 'event = hold');
  t.equal(params.on_hold, true, 'on_hold = true');
  t.equal(params.sip_method, 'INVITE', 'sip_method = INVITE');
  t.equal(params.sip_body, HOLD_SDP, 'forwards the offered SDP');
  t.equal(params.call_sid, 'call-sid-abc', 'callInfo is merged in (call_sid present)');
  t.equal(params.account_sid, 'acct-sid-xyz', 'callInfo is merged in (account_sid present)');
  t.end();
});

test('CallSession._notifyHoldState - a=inactive also counts as hold', (t) => {
  const s = makeSession();
  notifyHoldState.call(s, {body: INACTIVE_SDP, headers: {}});
  t.equal(s._onHold, true, 'a=inactive treated as hold');
  t.deepEqual(s.emitted, ['hold'], 'emits "hold"');
  t.end();
});

test('CallSession._notifyHoldState - no-op when hold state is unchanged', (t) => {
  const s = makeSession({_onHold: true});
  notifyHoldState.call(s, {body: HOLD_SDP, headers: {}});
  t.equal(s.emitted.length, 0, 'does not re-emit when already on hold');
  t.equal(s.hookCalls.length, 0, 'does not re-invoke the hook when already on hold');
  t.end();
});

test('CallSession._notifyHoldState - fires "unhold" on retrieve', (t) => {
  const s = makeSession({_onHold: true});
  notifyHoldState.call(s, {body: ACTIVE_SDP, headers: {}});
  t.equal(s._onHold, false, 'clears on-hold state');
  t.deepEqual(s.emitted, ['unhold'], 'emits "unhold"');
  t.equal(s.hookCalls[0].params.event, 'unhold', 'hook event = unhold');
  t.equal(s.hookCalls[0].params.on_hold, false, 'on_hold = false');
  t.end();
});

test('CallSession._notifyHoldState - still emits locally when no hook configured', (t) => {
  const s = makeSession({sipRequestWithinDialogHook: undefined});
  notifyHoldState.call(s, {body: HOLD_SDP, headers: {}});
  t.deepEqual(s.emitted, ['hold'], 'local event still emitted');
  t.equal(s.hookCalls.length, 0, 'no hook invoked when unconfigured');
  t.end();
});

test('SipRecCallSession._notifySipRecReinvite - detects hold via a=inactive on either stream', (t) => {
  const s = makeSession();
  notifySipRecReinvite.call(s, {body: 'multipart-body', headers: {}}, ACTIVE_SDP, INACTIVE_SDP);

  t.equal(s._onHold, true, 'a=inactive on stream 2 => hold');
  t.deepEqual(s.emitted, ['hold'], 'emits "hold" on transition');
  t.equal(s.hookCalls.length, 1, 'invokes the hook');

  const {params} = s.hookCalls[0];
  t.equal(params.siprec, true, 'marks payload as siprec');
  t.equal(params.event, 'hold', 'event = hold on transition');
  t.equal(params.on_hold, true, 'on_hold = true');
  t.equal(params.sip_body, 'multipart-body', 'forwards the full multipart body');
  t.end();
});

test('SipRecCallSession._notifySipRecReinvite - non-transition reinvite still forwarded as event:reinvite', (t) => {
  const s = makeSession({_onHold: false});
  notifySipRecReinvite.call(s, {body: 'multipart-body', headers: {}}, ACTIVE_SDP, ACTIVE_SDP);

  t.equal(s._onHold, false, 'stays off hold');
  t.equal(s.emitted.length, 0, 'no local event when state is unchanged');
  t.equal(s.hookCalls.length, 1, 'hook still invoked (SIPREC forwards every reinvite)');
  t.equal(s.hookCalls[0].params.event, 'reinvite', 'event = reinvite when there is no transition');
  t.end();
});

test('SipRecCallSession._notifySipRecReinvite - emits "unhold" on retrieve transition', (t) => {
  const s = makeSession({_onHold: true});
  notifySipRecReinvite.call(s, {body: 'multipart-body', headers: {}}, ACTIVE_SDP, ACTIVE_SDP);

  t.equal(s._onHold, false, 'clears on-hold state');
  t.deepEqual(s.emitted, ['unhold'], 'emits "unhold" on transition');
  t.equal(s.hookCalls[0].params.event, 'unhold', 'hook event = unhold');
  t.end();
});

test('feature is inert unless JAMBONES_HOLD_UNHOLD_EVENTS is set', (t) => {
  // reload the modules with the flag unset to exercise the disabled path
  const {CallSession: CS, SipRecCallSession: SR} = loadWith(undefined);
  try {
    const s1 = makeSession();
    CS.prototype._notifyHoldState.call(s1, {body: HOLD_SDP, headers: {}});
    t.equal(s1.emitted.length, 0, 'CallSession: no event emitted when disabled');
    t.equal(s1.hookCalls.length, 0, 'CallSession: no hook invoked when disabled');

    const s2 = makeSession();
    SR.prototype._notifySipRecReinvite.call(s2, {body: 'multipart-body', headers: {}}, ACTIVE_SDP, INACTIVE_SDP);
    t.equal(s2.emitted.length, 0, 'SipRecCallSession: no event emitted when disabled');
    t.equal(s2.hookCalls.length, 0, 'SipRecCallSession: no hook invoked when disabled');
  } finally {
    // restore the ambient flag + module cache for the rest of the suite
    loadWith(ORIGINAL_FLAG);
  }
  t.end();
});
