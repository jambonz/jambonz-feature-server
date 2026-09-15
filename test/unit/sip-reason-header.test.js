const test = require('node:test');
const assert = require('node:assert');
const SipMessage = require('drachtio-srf/lib/sip-parser/message');
const CallInfo = require('../../lib/session/call-info');
const snakeCaseKeys = require('../../lib/utils/snakecase-keys');
const {reasonHeaderFromSipMessage} = require('../../lib/utils/sip-reason');
const {CallDirection, CallStatus} = require('../../lib/utils/constants');

/* build the outbound INVITE that CallInfo is constructed from */
const makeReq = () => {
  const req = new SipMessage([
    'INVITE sip:+971555551234@example.com SIP/2.0',
    'Call-ID: daa1269b-0b91-1240-9db3-022758ab7fff',
    'From: <sip:+971455550000@example.com>;tag=abc123',
    'To: <sip:+971555551234@example.com>',
    'Content-Length: 0',
    '', ''
  ].join('\r\n'));
  req.srf = {locals: {localSipAddress: '172.30.29.123:5060'}};
  return req;
};

const makeSipMessage = (startLine, headers = []) => new SipMessage([
  startLine,
  'Call-ID: daa24f5d-0b91-1240-14ab-0ec7040a32ad',
  ...headers,
  'Content-Length: 0',
  '', ''
].join('\r\n'));

const makeCallInfo = () => new CallInfo({
  direction: CallDirection.Outbound,
  req: makeReq(),
  to: '+971555551234',
  callSid: '9921be00-ced0-45cb-add1-e02f9ce555ab',
  accountSid: 'e43117dc-4b91-430c-82ad-74d2725f3026',
  applicationSid: '72c5c38f-9bba-40ce-aa83-aaa6be55e1b5',
  traceId: '615e314ac26241863b905931d9aad440'
});


/* mirrors filterNullsAndObjects in realtimedb-helpers, which decides what actually
   reaches the redis call hash via hmset */
const redisFields = (callInfo) => Object.keys(callInfo)
  .filter((k) => callInfo[k] !== null && typeof callInfo[k] !== 'undefined' && typeof callInfo[k] !== 'object');

/* the payload a call status webhook consumer actually receives */
const statusPayload = (callInfo) => snakeCaseKeys(callInfo.toJSON(), ['customerData', 'sip', 'env_vars', 'args']);

test('Reason header on a final failure response is surfaced as sip_reason_header', () => {
  const callInfo = makeCallInfo();
  const res = makeSipMessage('SIP/2.0 408 Request Timeout', ['Reason: Q.850 ;cause=18']);

  callInfo.updateCallStatus(CallStatus.Failed, 408, 'Request Timeout', reasonHeaderFromSipMessage(res));
  const payload = statusPayload(callInfo);

  assert.strictEqual(payload.sip_reason_header, 'Q.850 ;cause=18');
  /* sip_reason must keep meaning the status-line phrase - existing consumers depend on it */
  assert.strictEqual(payload.sip_reason, 'Request Timeout');
  assert.strictEqual(payload.sip_status, 408);
});

test('spacing variants of the Reason header are passed through verbatim', () => {
  for (const raw of ['Q.850 ;cause=31', 'Q.850;cause=31', 'Q.850 ; cause=31']) {
    const callInfo = makeCallInfo();
    const res = makeSipMessage('SIP/2.0 480 Temporarily Unavailable', [`Reason: ${raw}`]);
    callInfo.updateCallStatus(CallStatus.Failed, 480, 'Temporarily Unavailable', reasonHeaderFromSipMessage(res));
    assert.strictEqual(statusPayload(callInfo).sip_reason_header, raw);
  }
});

test('a response with no Reason header adds no key to the payload', () => {
  const callInfo = makeCallInfo();
  const res = makeSipMessage('SIP/2.0 503 Service Unavailable');

  callInfo.updateCallStatus(CallStatus.Failed, 503, 'Service Unavailable', reasonHeaderFromSipMessage(res));
  const payload = statusPayload(callInfo);

  assert.ok(!('sip_reason_header' in payload), 'payload must be unchanged for carriers that send no Reason');
});

test('repeated Reason headers are preserved rather than one being dropped', () => {
  const callInfo = makeCallInfo();
  const res = makeSipMessage('SIP/2.0 486 Busy Here', [
    'Reason: SIP ;cause=486 ;text="busy"',
    'Reason: Q.850 ;cause=17'
  ]);

  callInfo.updateCallStatus(CallStatus.Busy, 486, 'Busy Here', reasonHeaderFromSipMessage(res));
  const header = statusPayload(callInfo).sip_reason_header;

  assert.match(header, /SIP ;cause=486/);
  assert.match(header, /Q\.850 ;cause=17/);
});

test('a Reason header on a BYE is surfaced on the completed event', () => {
  const callInfo = makeCallInfo();
  const bye = new SipMessage([
    'BYE sip:+971555551234@example.com SIP/2.0',
    'Call-ID: daa24f5d-0b91-1240-14ab-0ec7040a32ad',
    'Reason: Q.850 ;cause=16',
    'Content-Length: 0',
    '', ''
  ].join('\r\n'));

  callInfo.duration = 42;
  callInfo.updateCallStatus(CallStatus.Completed, 200, 'OK', reasonHeaderFromSipMessage(bye));

  assert.strictEqual(statusPayload(callInfo).sip_reason_header, 'Q.850 ;cause=16');
});

test('a Reason header does not linger onto a later status change that has none', () => {
  const callInfo = makeCallInfo();
  const prov = makeSipMessage('SIP/2.0 183 Session Progress', ['Reason: Q.850 ;cause=31']);
  const ok = makeSipMessage('SIP/2.0 200 OK');

  callInfo.updateCallStatus(CallStatus.EarlyMedia, 183, 'Session Progress', reasonHeaderFromSipMessage(prov));
  assert.strictEqual(statusPayload(callInfo).sip_reason_header, 'Q.850 ;cause=31');

  callInfo.updateCallStatus(CallStatus.InProgress, 200, 'OK', reasonHeaderFromSipMessage(ok));
  assert.ok(!('sip_reason_header' in statusPayload(callInfo)),
    'each status event must report the Reason of the message that caused it');
});

test('status changes with no SIP message at all are handled', () => {
  /* e.g. jambonz hanging up the call itself, or a media timeout */
  assert.strictEqual(reasonHeaderFromSipMessage(undefined), undefined);
  assert.strictEqual(reasonHeaderFromSipMessage(null), undefined);
  assert.strictEqual(reasonHeaderFromSipMessage({}), undefined);

  const callInfo = makeCallInfo();
  callInfo.duration = 7;
  callInfo.updateCallStatus(CallStatus.Completed, 200, 'OK', reasonHeaderFromSipMessage(undefined));
  assert.ok(!('sip_reason_header' in statusPayload(callInfo)));
});


test('the Reason header never enters the redis call record', () => {
  const callInfo = makeCallInfo();
  const res = makeSipMessage('SIP/2.0 480 Temporarily Unavailable', ['Reason: Q.850 ;cause=31']);

  callInfo.updateCallStatus(CallStatus.Failed, 480, 'Temporarily Unavailable', reasonHeaderFromSipMessage(res));

  /* It belongs on the webhook... */
  assert.strictEqual(statusPayload(callInfo).sip_reason_header, 'Q.850 ;cause=31');

  /* ...and must be kept out of the redis call record, which is written with hmset - a
     MERGE. A field that can go from set back to unset would otherwise strand a cause from
     an earlier status change where GET /Calls/:sid reports it.
     There is more than one writer and they project from DIFFERENT bases - the status
     change and recording-flag writes send the webhook payload, SingleDialer sends the
     CallInfo instance - so assert the projection holds for both shapes. The sessions apply
     it by wrapping updateCallStatus at the boundary rather than at each call site, so a
     newly added writer cannot bypass it by forgetting to ask. */
  assert.ok(!redisFields(CallInfo.toRedisRecord(callInfo.toJSON())).includes('sipReasonHeader'),
    'CallSession must not write sipReasonHeader to the call record');
  assert.ok(!redisFields(CallInfo.toRedisRecord(callInfo)).includes('sipReasonHeader'),
    'SingleDialer must not write sipReasonHeader to the call record');

  /* the exclusion must not take anything else with it */
  assert.ok(redisFields(CallInfo.toRedisRecord(callInfo.toJSON())).includes('sipReason'));
  assert.ok(redisFields(CallInfo.toRedisRecord(callInfo.toJSON())).includes('callStatus'));
});
