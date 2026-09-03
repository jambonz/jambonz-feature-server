/**
 * Standalone smoke test for SIPREC recording across a cross-feature-server dequeue.
 * Needs a real multi-feature-server deployment, so it is deliberately outside the
 * mocha suite. See README.md.
 */

const http = require('http');
const crypto = require('crypto');
const FakeSrs = require('./fake-srs');
const FakeEndpoint = require('./fake-endpoint');

const cfg = {
  httpPort: parseInt(process.env.SMOKE_HTTP_PORT || '3111', 10),
  httpAdvertise: process.env.SMOKE_HTTP_ADVERTISE,
  srsPort: parseInt(process.env.SMOKE_SRS_PORT || '5093', 10),
  srsRtpPortBase: parseInt(process.env.SMOKE_SRS_RTP_PORT_BASE || '40100', 10),
  srsAdvertiseIp: process.env.SMOKE_SRS_ADVERTISE_IP,
  featureServers: (process.env.SMOKE_FEATURE_SERVERS || '').split(',').map((s) => s.trim()).filter((s) => s),
  accountSid: process.env.SMOKE_ACCOUNT_SID,
  agentFrom: process.env.SMOKE_AGENT_FROM || '15551234567',
  agentTo: process.env.SMOKE_AGENT_TO_JSON ?
    JSON.parse(process.env.SMOKE_AGENT_TO_JSON) :
    (process.env.SMOKE_AGENT_SIP_URI ? {type: 'sip', sipUri: process.env.SMOKE_AGENT_SIP_URI} : null),
  mode: process.env.SMOKE_MODE || 'rest',
  epSipPort: parseInt(process.env.SMOKE_EP_SIP_PORT || '5094', 10),
  epRtpPortBase: parseInt(process.env.SMOKE_EP_RTP_PORT_BASE || '40200', 10),
  queue: process.env.SMOKE_QUEUE || 'smoke-siprec',
  settleSecs: parseInt(process.env.SMOKE_SETTLE_SECS || '15', 10),
  hangupBy: process.env.SMOKE_HANGUP_BY || 'jambonz',
  waitSecs: parseInt(process.env.SMOKE_WAIT_SECS || '300', 10)
};

const log = (msg) => console.log(`${new Date().toISOString().slice(11, 23)}  ${msg}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checkConfig = () => {
  const missing = [];
  if (!cfg.httpAdvertise) missing.push('SMOKE_HTTP_ADVERTISE');
  if (!cfg.srsAdvertiseIp) missing.push('SMOKE_SRS_ADVERTISE_IP');
  if (!cfg.accountSid) missing.push('SMOKE_ACCOUNT_SID');
  if (!cfg.agentTo && cfg.mode !== 'rest') missing.push('SMOKE_AGENT_SIP_URI (or SMOKE_AGENT_TO_JSON)');
  if (cfg.featureServers.length < 2) missing.push('SMOKE_FEATURE_SERVERS (need at least 2)');
  if (missing.length) {
    console.error(`missing configuration: ${missing.join(', ')}\nsee README.md`);
    process.exit(2);
  }
};

const postJson = (url, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body);
  const u = new URL(url);
  const req = http.request({
    hostname: u.hostname,
    port: u.port,
    path: u.pathname,
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)}
  }, (res) => {
    let payload = '';
    res.on('data', (chunk) => payload += chunk);
    res.on('end', () => resolve({status: res.statusCode, body: payload}));
  });
  req.on('error', reject);
  req.end(data);
});

const state = {
  inbound: null,          // {callSid, fs}
  agentCallSid: null,
  tEnqueued: 0,
  tDequeueReturned: 0,
  tWaitHookFromFsB: 0,
  fsB: null,
  transferSeen: false,
  statusEvents: []
};

/* the feature server that fetched a hook is the one currently running the call */
const callerFs = (req) => {
  const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return cfg.featureServers.find((fs) => fs.split(':')[0] === addr) || addr;
};

const verbsForInbound = (srsUrl, needsAnswer) => [
  ...(needsAnswer ? [{verb: 'answer'}] : []),
  {
    verb: 'config',
    record: {
      action: 'startCallRecording',
      type: 'siprec',
      siprecServerURL: srsUrl,
      recordingID: crypto.randomUUID()
    }
  },
  {
    verb: 'enqueue',
    name: cfg.queue,
    waitHook: {url: `http://${cfg.httpAdvertise}/wait`, method: 'POST'}
  }
];

const startAppServer = (srs) => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => {
      const payload = body ? JSON.parse(body) : {};
      const fs = callerFs(req);
      const reply = (verbs) => {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(verbs));
      };

      switch (req.url.split('?')[0]) {
        case '/inbound':
          if (state.inbound) {
            log(`ignoring extra inbound call ${payload.call_sid}`);
            return reply([{verb: 'hangup'}]);
          }
          state.inbound = {callSid: payload.call_sid, fs};
          state.tEnqueued = Date.now();
          log(`inbound call ${payload.call_sid} answered on feature server ${fs}`);
          return reply(verbsForInbound(srs.srsUrl, cfg.mode !== 'rest'));

        case '/wait':
          /* after the REFER the receiving feature server re-runs enqueue and fetches
             this hook itself, which is our marker that the call actually moved */
          if (state.inbound && fs !== state.inbound.fs) {
            if (!state.transferSeen) {
              state.transferSeen = true;
              state.tWaitHookFromFsB = Date.now();
              log(`call moved to feature server ${fs}`);
            }
          }
          return reply([{verb: 'pause', length: 30}]);

        case '/agent':
          state.agentCallSid = payload.call_sid;
          state.tDequeueReturned = Date.now();
          log(`agent call ${payload.call_sid} answered on feature server ${fs}, returning dequeue`);
          return reply([
            {verb: 'dequeue', name: cfg.queue, callSid: state.inbound.callSid, timeout: 30}
          ]);

        case '/status':
          state.statusEvents.push({call_sid: payload.call_sid, status: payload.call_status, fs});
          return reply([]);

        default:
          res.writeHead(404);
          return res.end();
      }
    });
  });
  return new Promise((resolve) => server.listen(cfg.httpPort, () => resolve(server)));
};

const pickOtherFs = (fsA) => {
  const other = cfg.featureServers.find((fs) => fs.split(':')[0] !== fsA.split(':')[0]);
  return other;
};

const createCall = async(fs, {to, hook, label}) => {
  const body = {
    account_sid: cfg.accountSid,
    from: cfg.agentFrom,
    to,
    call_hook: {url: `http://${cfg.httpAdvertise}${hook}`, method: 'POST'},
    call_status_hook: {url: `http://${cfg.httpAdvertise}/status`, method: 'POST'}
  };
  log(`creating ${label} call on feature server ${fs}`);
  const res = await postJson(`http://${fs}/v1/createCall`, body);
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`createCall on ${fs} failed: ${res.status} ${res.body}`);
  }
  return res;
};

const hangup = async() => {
  if (cfg.hangupBy !== 'jambonz') {
    log('waiting for the caller to hang up');
    return;
  }
  /* the call is on the receiving feature server now, so try both */
  for (const fs of [state.fsB, state.inbound.fs]) {
    const res = await postJson(`http://${fs}/v1/updateCall/${state.inbound.callSid}`, {call_status: 'completed'})
      .catch((err) => ({status: 0, body: err.message}));
    if (res.status === 200 || res.status === 204) {
      log(`hung up the call from jambonz via ${fs}`);
      return;
    }
  }
  log('could not hang up via the feature server API - hang up the caller manually');
};

const report = (srs, endpoint) => {
  const t0 = state.tEnqueued;
  const tTransfer = state.tWaitHookFromFsB || state.tDequeueReturned;
  const before = srs.window(Math.min(t0 + 2000, tTransfer - 1000), tTransfer);
  const after = srs.window(tTransfer + 2000, tTransfer + 2000 + (cfg.settleSecs * 1000));
  const rate = (w) => w.perStream.reduce((sum, s) => sum + s.rate, 0);
  const gotInvite = srs.events.some((e) => e.event === 'invite');
  const gotBye = srs.events.some((e) => e.event === 'bye');
  const reinvites = srs.events.filter((e) => e.event === 'reinvite').length;
  const extra = srs.events.filter((e) => e.event === 'extra-invite').length;

  console.log('\n================ SIPREC cross-feature-server transfer ================');
  console.log(`inbound call        : ${state.inbound?.callSid} on ${state.inbound?.fs}`);
  console.log(`agent call          : ${state.agentCallSid} on ${state.fsB}`);
  console.log(`call moved          : ${state.transferSeen ? 'yes' : 'not observed'}`);
  console.log(`SIPREC INVITE       : ${gotInvite ? 'received' : 'NEVER RECEIVED'}`);
  console.log(`re-INVITEs from SBC : ${reinvites}`);
  console.log(`extra SIPREC calls  : ${extra}`);
  console.log(`BYE from SBC        : ${gotBye ? 'received' : 'NEVER RECEIVED'}`);
  console.log(`rtp before transfer : ${before.totalPackets} packets, ` +
    before.perStream.map((s) => `stream ${s.label} ${s.rate.toFixed(0)}/s`).join(', '));
  console.log(`rtp after  transfer : ${after.totalPackets} packets, ` +
    after.perStream.map((s) => `stream ${s.label} ${s.rate.toFixed(0)}/s`).join(', '));
  console.log(`packet rate         : ${rate(before).toFixed(0)}/s before -> ${rate(after).toFixed(0)}/s after`);
  console.log(`longest silence after transfer: ${after.longestGapMs} ms`);
  if (endpoint && endpoint.answered) {
    console.log(`test endpoint      : answered ${endpoint.answered} leg(s), ` +
      `sent ${[...endpoint.calls.values()].reduce((sum, c) => sum + c.sent, 0)} rtp packets`);
  }
  console.log('events:');
  for (const e of srs.events) {
    console.log(`  +${((e.at - t0) / 1000).toFixed(1)}s  ${e.event}${e.detail ? ` (${e.detail})` : ''}`);
  }

  const failures = [];
  if (!gotInvite) failures.push('no SIPREC INVITE reached the recorder - the SBC never started the session');
  if (before.totalPackets === 0) {
    failures.push('no media before the transfer either - the caller must send audio continuously ' +
      '(see README), this run proves nothing');
  }
  else {
    const kept = rate(before) > 0 ? rate(after) / rate(before) : 0;
    if (after.totalPackets === 0) {
      failures.push('recording went silent at the transfer - the media fork was not rebuilt ' +
        '(SrsClient.resubscribe not called or not effective)');
    }
    else if (kept < 0.5) {
      failures.push(`media dropped to ${(kept * 100).toFixed(0)}% of the pre-transfer volume ` +
        'after the transfer - fork only partly rebuilt');
    }
    if (after.longestGapMs > 2000) {
      failures.push(`${after.longestGapMs}ms of silence after the transfer - fork interrupted`);
    }
  }
  if (!gotBye) {
    failures.push('no BYE for the SIPREC session - the recorder is left to time out ' +
      '(_stopRecording missing on the transferred leg)');
  }
  if (extra) failures.push('the SBC opened a second SIPREC session for one call');

  console.log('');
  if (failures.length) {
    console.log('RESULT: FAIL');
    for (const f of failures) console.log(`  - ${f}`);
  }
  else {
    console.log('RESULT: PASS - recording survived the move and was torn down cleanly');
  }
  console.log('======================================================================\n');
  return failures.length === 0;
};

const main = async() => {
  checkConfig();
  const srs = new FakeSrs(log, {
    sipPort: cfg.srsPort,
    rtpPortBase: cfg.srsRtpPortBase,
    advertiseIp: cfg.srsAdvertiseIp
  });
  await srs.start();
  const endpoint = new FakeEndpoint(log, {
    sipPort: cfg.epSipPort,
    rtpPortBase: cfg.epRtpPortBase,
    advertiseIp: cfg.srsAdvertiseIp
  });
  if (cfg.mode === 'rest') await endpoint.start();
  const server = await startAppServer(srs);
  log(`app hooks listening on http://${cfg.httpAdvertise} (local port ${cfg.httpPort})`);

  if (cfg.mode === 'rest') {
    /* the test dials its own endpoint for both legs, so it needs nothing configured
       in the portal - the recorded leg is a REST call through sbc-outbound */
    await createCall(cfg.featureServers[0], {
      to: {type: 'sip', sipUri: endpoint.uri('caller')},
      hook: '/inbound',
      label: 'recorded'
    });
  }
  else {
    console.log('');
    console.log('point a jambonz application at this call hook and place ONE inbound call:');
    console.log(`  call hook        http://${cfg.httpAdvertise}/inbound`);
    console.log(`  call status hook http://${cfg.httpAdvertise}/status`);
    console.log('the caller must transmit audio continuously - a muted caller makes the');
    console.log('media check meaningless.');
    console.log('');
  }

  const deadline = Date.now() + (cfg.waitSecs * 1000);
  while (!state.inbound && Date.now() < deadline) await sleep(500);
  if (!state.inbound) {
    console.error(`no call reached the app within ${cfg.waitSecs}s, giving up`);
    process.exit(2);
  }

  /* let the recording establish and the caller settle into the queue */
  await sleep(5000);

  state.fsB = pickOtherFs(state.inbound.fs);
  if (!state.fsB) {
    console.error(`inbound call landed on ${state.inbound.fs} and no other feature server is configured`);
    process.exit(2);
  }
  await createCall(state.fsB, {
    to: cfg.mode === 'rest' ? {type: 'sip', sipUri: endpoint.uri('agent')} : cfg.agentTo,
    hook: '/agent',
    label: 'agent'
  });

  const bridgeDeadline = Date.now() + 45000;
  while (!state.tDequeueReturned && Date.now() < bridgeDeadline) await sleep(250);
  if (!state.tDequeueReturned) {
    console.error('agent call never reached the app - check the agent target and carrier');
    process.exit(2);
  }

  log(`bridged, watching the recording for ${cfg.settleSecs}s`);
  await sleep((cfg.settleSecs + 3) * 1000);

  await hangup();
  const byeDeadline = Date.now() + 10000;
  while (!srs.events.some((e) => e.event === 'bye') && Date.now() < byeDeadline) await sleep(250);

  const passed = report(srs, endpoint);
  await srs.stop();
  await endpoint.stop();
  server.close();
  process.exit(passed ? 0 : 1);
};

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
