const router = require('express').Router();
const makeTask = require('../../tasks/make_task');
const RestCallSession = require('../../session/rest-call-session');
const CallInfo = require('../../session/call-info');
const {CallDirection, CallStatus} = require('../../utils/constants');
const SipError = require('drachtio-srf').SipError;
const Srf = require('drachtio-srf');
const sysError = require('./error');
const Mrf = require('drachtio-fsmrf');
const installSrfLocals = require('../../utils/install-srf-locals');
const Requestor = require('../../utils/requestor');
let idxDrachtio = 0;
let idxSbc = 0;
let srfs = [];
let initializedSrfs = false;

/**
 * Connect to a single drachtio server, returning a Promise when connected.
 * Upon connect, add ourselves to the list of active servers, removing if we lose the connection
 */
function connectSrf(logger, d) {
  return new Promise((resolve, reject) => {
    const srf = new Srf();
    srf.connect(d);
    srf
      .on('connect', (err, hp) => {
        if (!err) logger.info(`connectSrf: Connected to drachtio at ${hp} for REST outdials`);
        else logger.error(`connectSrf: Error connecting to drachtio for outdials: ${err}`);
        srf.locals.mrf = new Mrf(srf);
        installSrfLocals(srf, logger);
        srfs.push(srf);
        resolve(srf);
      })
      .on('error', (err) => {
        logger.error(err, 'connectSrf error');
        srfs = srfs.filter((s) => s !== srf);
        reject(err);
      });
  });
}

/**
 * Retrieve a connection to a drachtio server, lazily creating when first called
 */
function getSrfForOutdial(logger) {
  return new Promise((resolve, reject) => {
    if (srfs.length === 0 && initializedSrfs) return reject('no available drachtio servers for outdial');
    else if (srfs.length > 0) return resolve(srfs[idxDrachtio++ % srfs.length]);
    else {
      const {srf} = require('../../../');
      const drachtio = srf.locals.drachtio;
      logger.debug(drachtio, 'getSrfForOutdial - attempting to connect');
      initializedSrfs = true;
      resolve(Promise.race(drachtio.map((d) => connectSrf(logger, d))));
    }
  });
}

router.post('/', async(req, res) => {
  const logger = req.app.locals.logger;
  logger.debug({body: req.body}, 'got createCall request');
  try {
    let uri, cs, to;
    const restDial = makeTask(logger, {'rest:dial': req.body});
    const srf = await getSrfForOutdial(logger);
    const sbcAddress = srf.locals.sbcs[idxSbc++ % srf.locals.sbcs.length];
    const target = restDial.to;
    const opts = { callingNumber: restDial.from };

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

    const ms = await mrf.connect(srf.locals.freeswitch);
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


    /**
     * create our application object -
     * not from the database as per an inbound call,
     * but from the provided params in the request
     */
    const app = req.body;

    /**
     * attach our requestor and notifier objects
     * these will be used for all http requests we make during this call
     */
    app.requestor = new Requestor(logger, app.call_hook);
    if (app.call_status_hook) app.notifier = new Requestor(logger, app.call_status_hook);
    else app.notifier = {request: () => {}};

    /* now launch the outdial */
    try {
      const dlg = await srf.createUAC(uri, opts, {
        cbRequest: (err, inviteReq) => {
          if (err) {
            logger.error(err, 'createCall Error creating call');
            res.status(500).send('Call Failure');
            ep.destroy();
          }
          /* ok our outbound NVITE is in flight */

          const tasks = [restDial];
          const callInfo = new CallInfo({
            direction: CallDirection.Outbound,
            req: inviteReq,
            to,
            tag: app.tag,
            accountSid: req.body.account_sid,
            applicationSid: app.application_sid
          });
          cs = new RestCallSession({logger, application: app, srf, req: inviteReq, ep, tasks, callInfo});
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
