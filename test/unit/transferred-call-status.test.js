const test = require('node:test');
const assert = require('node:assert');

/* call-session decrypts credentials at require time, so it needs a secret present */
process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'foobar';
process.env.JAMBONES_LOGLEVEL = process.env.JAMBONES_LOGLEVEL || 'error';

const CallSession = require('../../lib/session/call-session');
const {CallStatus} = require('../../lib/utils/constants');

/* a CallSession is far too entangled to construct here, and none of what
   _notifyCallStatusChange touches needs the constructor to have run */
const makeSession = ({transferredCall = false, recordAllCalls = false} = {}) => {
  const calls = {statusCallback: [], redis: [], callInfo: [], recorderStarted: 0, recorderStopped: 0};
  const session = Object.create(CallSession.prototype);

  Object.assign(session, {
    callMoved: false,
    notifiedComplete: false,
    serviceUrl: 'http://127.0.0.1:3000',
    application: {transferredCall, record_all_calls: false},
    accountInfo: {account: {record_all_calls: recordAllCalls}},
    backgroundTaskManager: {
      newTask: (name) => {
        if (name === 'record') calls.recorderStarted++;
      },
      stop: (name) => {
        if (name === 'record') calls.recorderStopped++;
      }
    },
    callInfo: {
      updateCallStatus: (...args) => calls.callInfo.push(args),
      toJSON: () => ({callStatus: 'x'})
    },
    logger: {debug: () => {}, info: () => {}, error: () => {}},
    executeStatusCallback: (callStatus, sipStatus) => calls.statusCallback.push({callStatus, sipStatus}),
    updateCallStatus: async (obj) => {
      calls.redis.push(obj);
    }
  });

  return {session, calls};
};

const notified = (calls) => calls.statusCallback.map(({callStatus}) => callStatus);

const EARLY_STATUSES = [
  [CallStatus.Trying, 100],
  [CallStatus.Ringing, 180],
  [CallStatus.EarlyMedia, 183],
  [CallStatus.InProgress, 200]
];

test('a transferred call does not re-notify statuses the first server already sent', async () => {
  const {session, calls} = makeSession({transferredCall: true});

  for (const [callStatus, sipStatus] of EARLY_STATUSES) {
    await session._notifyCallStatusChange({callStatus, sipStatus});
  }

  assert.deepStrictEqual(notified(calls), [],
    'no early status should reach the application for a transferred call');
});

test('a normal call still notifies every one of those statuses', async () => {
  const {session, calls} = makeSession({transferredCall: false});

  for (const [callStatus, sipStatus] of EARLY_STATUSES) {
    await session._notifyCallStatusChange({callStatus, sipStatus});
  }

  assert.deepStrictEqual(notified(calls), EARLY_STATUSES.map(([s]) => s),
    'suppression must apply only to transferred calls');
});

test('a transferred call still notifies completion', async () => {
  const {session, calls} = makeSession({transferredCall: true});

  await session._notifyCallStatusChange({callStatus: CallStatus.Completed, sipStatus: 200, duration: 12});

  assert.deepStrictEqual(notified(calls), [CallStatus.Completed],
    'only the statuses sent before the transfer are duplicates');
});

test('suppressing the notification still updates callInfo and the redis call record', async () => {
  const {session, calls} = makeSession({transferredCall: true});

  await session._notifyCallStatusChange({callStatus: CallStatus.InProgress, sipStatus: 200});

  assert.strictEqual(calls.statusCallback.length, 0);
  assert.strictEqual(calls.callInfo.length, 1, 'callInfo must still track the status');
  assert.strictEqual(calls.redis.length, 1, 'the call record must still be written to redis');
});

test('suppressing the notification still starts record-all-calls', async () => {
  const {session, calls} = makeSession({transferredCall: true, recordAllCalls: true});

  await session._notifyCallStatusChange({callStatus: CallStatus.InProgress, sipStatus: 200});

  assert.strictEqual(calls.statusCallback.length, 0);
  assert.strictEqual(calls.recorderStarted, 1,
    'answering a transferred call must still start recording when record_all_calls is set');
});
