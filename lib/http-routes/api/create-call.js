const config = require('config');
const router = require('express').Router();
const sysError = require('./error');
const makeTask = require('../../tasks/make_task');
const RestCallSession = require('../../session/rest-call-session');
const CallInfo = require('../../session/call-info');
const {CallDirection, CallStatus} = require('../../utils/constants');
const parseUrl = require('parse-url');
const SipError = require('drachtio-srf').SipError;
const Srf = require('drachtio-srf');
const drachtio = config.get('outdials.drachtio');
const sbcs = config.get('outdials.sbc');
const Mrf = require('drachtio-fsmrf');
let idxDrachtio = 0;
let idxSbc = 0;

const srfs = drachtio.map((d) => {
  const srf = new Srf();
  srf.connect(d);
  srf
    .on('connect', (err, hp) => {
      if (!err) console.log(`Connected to drachtio at ${hp} for REST outdials`);
      else console.log(`Error connecting to drachtio for outdials: ${err}`);
      srf.locals.mrf = new Mrf(srf);
    })
    .on('error', (err) => console.log(err));
  return srf;
});

async function validate(logger, payload) {
  const data = Object.assign({}, {
    from: payload.from,
    to: payload.to,
    call_hook: payload.call_hook
  });

  const u = parseUrl(payload.call_hook.url);
  const myPort = u.port ? `:${u.port}` : '';
  payload.originalRequest = {
    baseUrl: `${u.protocol}://${u.resource}${myPort}`,
    method: payload.call_hook.method
  };
  if (payload.call_hook.username && payload.call_hook.password) {
    payload.originalRequest.auth = {
      username: payload.call_hook.username,
      password: payload.call_hook.password
    };
  }

  return makeTask(logger, {'rest:dial': data});
}

router.post('/', async(req, res) => {
  const logger = req.app.locals.logger;
  logger.debug({body: req.body}, 'got createCall request');
  try {
    let uri, cs, to;
    const restDial = await validate(logger, req.body);
    const sbcAddress = sbcs[idxSbc++ % sbcs.length];
    const srf = srfs[idxDrachtio++ % srfs.length];
    const target = restDial.to;
    const opts = {
      'callingNumber': restDial.from
    };

    switch (target.type) {
      case 'phone':
        uri = `sip:${target.number}@${sbcAddress}`;
        to = target.number;
        break;
      case 'user':
        uri = `sip:${target.name}`;
        to = target.name;
        break;
      case 'sip':
        uri = target.sipUri;
        to = uri;
        break;
    }

    /* create endpoint for outdial */
    const mrf = srf.locals.mrf;
    const ms = await mrf.connect(config.get('freeswitch'));
    logger.debug('createCall: successfully connected to media server');
    const ep = await ms.createEndpoint();
    logger.debug(`createCall: successfully allocated endpoint, sending INVITE to ${sbcAddress}`);
    ms.destroy();

    /* launch outdial */
    let sdp, sipLogger;
    const connectStream = async(remoteSdp) => {
      if (remoteSdp !== sdp) {
        ep.modify(sdp = remoteSdp);
        return true;
      }
      return false;
    };
    Object.assign(opts, {
      proxy: `sip:${sbcAddress}`,
      localSdp: ep.local.sdp
    });
    if (target.auth) opts.auth = this.target.auth;
    const application = req.body;

    try {
      const dlg = await srf.createUAC(uri, opts, {
        cbRequest: (err, inviteReq) => {
          if (err) {
            this.logger.error(err, 'createCall Error creating call');
            res.status(500).send('Call Failure');
            ep.destroy();
          }

          /* call is in flight */
          const tasks = [restDial];
          const callInfo = new CallInfo({
            direction: CallDirection.Outbound,
            req: inviteReq,
            to,
            tag: req.body.tag,
            accountSid: req.body.account_sid,
            applicationSid: req.body.application_sid
          });
          cs = new RestCallSession({logger, application, srf, req: inviteReq, ep, tasks, callInfo});
          cs.exec(req);

          res.status(201).json({sid: cs.callSid});

          sipLogger = logger.child({
            callSid: cs.callSid,
            callId: callInfo.callId
          });
          sipLogger.info(`outbound REST call attempt to ${JSON.stringify(target)} has been sent`);
        },
        cbProvisional: (prov) => {
          const callStatus = prov.body ? CallStatus.EarlyMedia : CallStatus.Ringing;
          if ([180, 183].includes(prov.status) && prov.body) connectStream(prov.body);
          restDial.emit('callStatus', prov.status, !!prov.body);
          cs.emit('callStatusChange', {callStatus, sipStatus: prov.status});
        }
      });
      connectStream(dlg.remote.sdp);
      cs.emit('callStatusChange', {callStatus: CallStatus.InProgress, sipStatus: 200});
      restDial.emit('callStatus', 200);
      restDial.emit('connect', dlg);
    }
    catch (err) {
      let callStatus = CallStatus.Failed;
      if (err instanceof SipError) {
        if ([486, 603].includes(err.status)) callStatus = CallStatus.Busy;
        else if (487 === err.status) callStatus = CallStatus.NoAnswer;
        sipLogger.info(`REST outdial failed with ${err.status}`);
        cs.emit('callStatusChange', {callStatus, sipStatus: err.status});
      }
      else {
        cs.emit('callStatusChange', {callStatus, sipStatus: 500});
        sipLogger.error({err}, 'REST outdial failed');
      }
      ep.destroy();
    }
  } catch (err) {
    sysError(logger, res, err);
  }

});

module.exports = router;
