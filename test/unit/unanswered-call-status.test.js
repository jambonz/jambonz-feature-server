const test = require('node:test');
const assert = require('node:assert');

/* call-session decrypts credentials at require time, so it needs a secret present */
process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'foobar';
process.env.JAMBONES_LOGLEVEL = process.env.JAMBONES_LOGLEVEL || 'error';

const InboundCallSession = require('../../lib/session/inbound-call-session');
const {CallStatus} = require('../../lib/utils/constants');

/* only what _onTasksDone and _notifyCallStatusChange touch */
const makeSession = ({finalResponseSent = false, callStatus = CallStatus.Trying, ...extra} = {}) => {
  const calls = {sent: [], statusCallback: []};
  const session = Object.create(InboundCallSession.prototype);

  Object.assign(session, {
    callMoved: false,
    notifiedComplete: false,
    serviceUrl: 'http://127.0.0.1:3000',
    application: {record_all_calls: false},
    accountInfo: {account: {record_all_calls: false}},
    backgroundTaskManager: {newTask: () => {}, stop: () => {}},
    rootSpan: {setAttributes: () => {}},
    req: {removeAllListeners: () => {}},
    res: {
      finalResponseSent,
      send: (status) => calls.sent.push(status)
    },
    callInfo: {
      callStatus,
      updateCallStatus(status) { this.callStatus = status; },
      toJSON: () => ({})
    },
    logger: {debug: () => {}, info: () => {}, error: () => {}},
    executeStatusCallback: async(callStatus, sipStatus) => { calls.statusCallback.push({callStatus, sipStatus}); },
    updateCallStatus: async() => {},
    ...extra
  });

  return {session, calls};
};

test('app ends an unanswered call: 603 plus a failed status event', () => {
  const {session, calls} = makeSession();

  session._onTasksDone();

  assert.deepStrictEqual(calls.sent, [603]);
  assert.deepStrictEqual(calls.statusCallback, [{callStatus: CallStatus.Failed, sipStatus: 603}]);
});

test('media server failure: 480 plus a failed status event', () => {
  const {session, calls} = makeSession({_mediaServerFailure: true});

  session._onTasksDone();

  assert.deepStrictEqual(calls.sent, [480]);
  assert.deepStrictEqual(calls.statusCallback, [{callStatus: CallStatus.Failed, sipStatus: 480}]);
});

test('endpoint allocation error: its SIP status is reported', () => {
  const {session, calls} = makeSession({_endpointAllocationError: {status: 488, reason: 'Not Acceptable Here'}});

  session._onTasksDone();

  assert.deepStrictEqual(calls.sent, [488]);
  assert.deepStrictEqual(calls.statusCallback, [{callStatus: CallStatus.Failed, sipStatus: 488}]);
});

test('caller already cancelled: no second terminal event', () => {
  const {session, calls} = makeSession({callStatus: CallStatus.NoAnswer});

  session._onTasksDone();

  assert.deepStrictEqual(calls.statusCallback, []);
});

test('call already answered or declined: nothing sent', () => {
  const {session, calls} = makeSession({finalResponseSent: true});

  session._onTasksDone();

  assert.deepStrictEqual(calls.sent, []);
  assert.deepStrictEqual(calls.statusCallback, []);
});
