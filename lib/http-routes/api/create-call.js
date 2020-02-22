const router = require('express').Router();
const makeTask = require('../../tasks/make_task');
const RestCallSession = require('../../session/rest-call-session');
const CallInfo = require('../../session/call-info');
const {CallDirection, CallStatus} = require('../../utils/constants');
const SipError = require('drachtio-srf').SipError;
const sysError = require('./error');
const Requestor = require('../../utils/requestor');

/**
 * Retrieve a connection to a drachtio server, lazily creating when first called
 */
function getSrfForOutdial(logger) {
  const {srf} = require('../../../');
  const {getSrf} = srf.locals;
  const srfForOutdial = getSrf();
  if (!srfForOutdial) throw new Error('no available feature servers for outbound call creation');
  return srfForOutdial;
}

router.post('/', async(req, res) => {
  const logger = req.app.locals.logger;
  logger.debug({body: req.body}, 'got createCall request');
  try {
    let uri, cs, to;
    const restDial = makeTask(logger, {'rest:dial': req.body});
    const srf = getSrfForOutdial(logger);
    const {getSBC, getFreeswitch} = srf.locals;
    const sbcAddress = getSBC();
    if (!sbcAddress) throw new Error('no available SBCs for outbound call creation');
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
    const ms = getFreeswitch();
    if (!ms) throw new Error('no available Freeswitch for outbound call creation');
    const ep = await ms.createEndpoint();
    logger.debug(`createCall: successfully allocated endpoint, sending INVITE to ${sbcAddress}`);

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
