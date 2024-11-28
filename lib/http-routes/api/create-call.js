const router = require('express').Router();
const makeTask = require('../../tasks/make_task');
const RestCallSession = require('../../session/rest-call-session');
const CallInfo = require('../../session/call-info');
const {CallDirection, CallStatus} = require('../../utils/constants');
const uuidv4 = require('uuid-random');
const SipError = require('drachtio-srf').SipError;
const { validationResult, body } = require('express-validator');
const { validate } = require('@jambonz/verb-specifications');
const sysError = require('./error');
const HttpRequestor = require('../../utils/http-requestor');
const WsRequestor = require('../../utils/ws-requestor');
const RootSpan = require('../../utils/call-tracer');
const dbUtils = require('../../utils/db-utils');
const { mergeSdpMedia, extractSdpMedia } = require('../../utils/sdp-utils');
const { createCallSchema, customSanitizeFunction } = require('../schemas/create-call');
const { selectHostPort } = require('../../utils/network');
const { JAMBONES_DIAL_SBC_FOR_REGISTERED_USER } = require('../../config');

const removeNullProperties = (obj) => (Object.keys(obj).forEach((key) => obj[key] === null && delete obj[key]), obj);
const removeNulls = (req, res, next) => {
  req.body = removeNullProperties(req.body);
  next();
};

router.post('/',
  removeNulls,
  createCallSchema,
  body('tag').custom((value) => {
    if (value) {
      customSanitizeFunction(value);
    }
    return true;
  }),
  async(req, res) => {
    const {logger} = req.app.locals;
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.info({errors: errors.array()}, 'POST /Calls: validation errors');
      return res.status(400).json({ errors: errors.array() });
    }
    const accountSid = req.body.account_sid;
    const {srf} = require('../../..');

    const app_json = req.body['app_json'];
    try {
    // app_json is created only by api-server.
      if (app_json) {
        // if available, delete from req before creating task
        delete req.body.app_json;
        // validate possible app_json via verb-specifications
        validate(logger, JSON.parse(app_json));
      }
    } catch (err) {
      logger.debug({ err }, `invalid app_json: ${err.message}`);
    }

    logger.debug({body: req.body}, 'got createCall request');
    try {
      let uri, cs, to;

      const restDial = makeTask(logger, { 'rest:dial': req.body });
      restDial.appJson = app_json;

      const {lookupAccountDetails, lookupCarrierByPhoneNumber, lookupCarrier} = dbUtils(logger, srf);
      const {
        lookupAppBySid
      }  = srf.locals.dbHelpers;
      const {getSBC, getFreeswitch} = srf.locals;
      let sbcAddress = getSBC();
      if (!sbcAddress) throw new Error('no available SBCs for outbound call creation');
      const target = restDial.to;
      const opts = {
        callingNumber: restDial.from,
        ...(restDial.callerName && {callingName: restDial.callerName}),
        headers: req.body.headers || {}
      };


      const {lookupTeamsByAccount, lookupAccountBySid} = srf.locals.dbHelpers;
      const account = await lookupAccountBySid(req.body.account_sid);
      const accountInfo = await lookupAccountDetails(req.body.account_sid);
      const callSid = uuidv4();
      const application = req.body.application_sid ? await lookupAppBySid(req.body.application_sid) : null;
      const record_all_calls = account.record_all_calls || (application && application.record_all_calls);
      const recordOutputFormat = account.record_format || 'mp3';
      const rootSpan = new RootSpan('rest-call', {
        callSid,
        accountSid,
        ...(req.body?.application_sid && {'X-Application-Sid': req.body.application_sid})
      });

      opts.headers = {
        ...opts.headers,
        'X-Jambonz-Routing': target.type,
        'X-Jambonz-FS-UUID': srf.locals.fsUUID,
        'X-Call-Sid': callSid,
        'X-Account-Sid': accountSid,
        'X-Trace-ID': rootSpan.traceId,
        ...(req.body?.application_sid && {'X-Application-Sid': req.body.application_sid}),
        ...(restDial.fromHost && {'X-Preferred-From-Host': restDial.fromHost}),
        ...(record_all_calls && {'X-Record-All-Calls': recordOutputFormat}),
        ...target.headers
      };

      switch (target.type) {
        case 'phone':
        case 'teams':
          uri = `sip:${target.number}@${sbcAddress}`;
          to = target.number;
          if ('teams' === target.type) {
            const obj = await lookupTeamsByAccount(accountSid);
            if (!obj) throw new Error('dial to ms teams not allowed; account must first be configured with teams info');
            Object.assign(opts.headers, {
              'X-MS-Teams-FQDN': obj.ms_teams_fqdn,
              'X-MS-Teams-Tenant-FQDN': target.tenant || obj.tenant_fqdn
            });
            if (target.vmail === true) uri = `${uri};opaque=app:voicemail`;
          }
          break;
        case 'user':
          uri = `sip:${target.name}`;
          to = target.name;
          if (target.overrideTo) {
            Object.assign(opts.headers, {
              'X-Override-To': target.overrideTo
            });
          }
          break;
        case 'sip':
          uri = target.sipUri;
          to = uri;
          break;
      }

      if (target.type === 'phone' && target.trunk) {
        const voip_carrier_sid = await lookupCarrier(req.body.account_sid, target.trunk);
        logger.info(
          `createCall: selected ${voip_carrier_sid} for requested carrier: ${target.trunk || 'unspecified'})`);
        if (voip_carrier_sid) {
          opts.headers['X-Requested-Carrier-Sid'] = voip_carrier_sid;
        }
      }

      // find handling sbc sip for called user
      if (JAMBONES_DIAL_SBC_FOR_REGISTERED_USER && target.type === 'user') {
        const { registrar }  = srf.locals.dbHelpers;
        const reg = await registrar.query(target.name);
        if (reg) {
          sbcAddress = selectHostPort(logger, reg.sbcAddress, 'tcp')[1];
        }
        //sbc outbound return 404 Notfound to handle case called user is not reigstered.
      }

      /**
     * trunk isn't specified,
     * check if from-number matches any existing numbers on Jambonz
     *  */
      if (target.type === 'phone' && !target.trunk) {
        const str = restDial.from || '';
        const callingNumber = str.startsWith('+') ? str.substring(1) : str;
        const voip_carrier_sid = await lookupCarrierByPhoneNumber(req.body.account_sid, callingNumber);
        logger.info(
          `createCall: selected ${voip_carrier_sid} for requested phone number: ${callingNumber || 'unspecified'})`);
        if (voip_carrier_sid) {
          opts.headers['X-Requested-Carrier-Sid'] = voip_carrier_sid;
        }
      }

      /* create endpoint for outdial */
      const ms = getFreeswitch();
      if (!ms) throw new Error('no available Freeswitch for outbound call creation');
      const ep = await ms.createEndpoint();
      logger.debug(`createCall: successfully allocated endpoint, sending INVITE to ${sbcAddress}`);

      /* launch outdial */
      let sdp, sipLogger;
      let dualEp;
      let localSdp = ep.local.sdp;

      if (req.body.dual_streams) {
        dualEp = await ms.createEndpoint();
        localSdp = mergeSdpMedia(localSdp, dualEp.local.sdp);
      }

      const connectStream = async(remoteSdp) => {
        if (remoteSdp !== sdp) {
          sdp = remoteSdp;
          if (req.body.dual_streams) {
            const [sdpLegA, sdpLebB] = extractSdpMedia(remoteSdp);

            await ep.modify(sdpLegA);
            await dualEp.modify(sdpLebB);
            await ep.bridge(dualEp);
          } else {
            ep.modify(sdp);
          }
          return true;
        }
        return false;
      };
      Object.assign(opts, {
        proxy: `sip:${sbcAddress}`,
        localSdp
      });
      if (target.auth) opts.auth = target.auth;


      /**
     * create our application object -
     * we merge the inbound call application,
     * with the provided app params from the request body
     */
      const app = {
        ...application,
        ...req.body
      };

      /**
     * attach our requestor and notifier objects
     * these will be used for all http requests we make during this call
     */
      if ('WS' === app.call_hook?.method || /^wss?:/.test(app.call_hook.url)) {
        logger.debug({call_hook: app.call_hook}, 'creating websocket for call hook');
        app.requestor = new WsRequestor(logger, account.account_sid, app.call_hook, account.webhook_secret) ;
        if (app.call_hook.url === app.call_status_hook.url  || !app.call_status_hook?.url) {
          logger.debug('reusing websocket for call status hook');
          app.notifier = app.requestor;
        }
      }
      else {
        logger.debug({call_hook: app.call_hook}, 'creating http client for call hook');
        app.requestor = new HttpRequestor(logger, account.account_sid, app.call_hook, account.webhook_secret);
      }
      if (!app.notifier && app.call_status_hook) {
        app.notifier = new HttpRequestor(logger, account.account_sid, app.call_status_hook, account.webhook_secret);
        logger.debug({call_status_hook: app.call_status_hook}, 'creating http client for call status hook');
      }
      else if (!app.notifier) {
        logger.debug('creating null call status hook');
        app.notifier = {request: () => {}, close: () => {}};
      }

      /* now launch the outdial */
      try {
        const dlg = await srf.createUAC(uri, {...opts,  followRedirects: true, keepUriOnRedirect: true}, {
          cbRequest: (err, inviteReq) => {
          /* in case of 302 redirect, this gets called twice, ignore the second
              except to update the req so that it can later be canceled if need be
          */
            if (res.headersSent) {
              logger.info(`create-call: got redirect, updating request to new call-id ${req.get('Call-ID')}`);
              if (cs) cs.req = inviteReq;
              return;
            }

            if (err) {
              logger.error(err, 'createCall Error creating call');
              res.status(500).send('Call Failure');
              return;
            }
            inviteReq.srf = srf;
            inviteReq.locals = {
              ...(inviteReq || {}),
              callSid,
              application_sid: app.application_sid
            };
            /* ok our outbound INVITE is in flight */

            const tasks = [restDial];
            sipLogger = logger.child({
              callSid,
              callId: inviteReq.get('Call-ID'),
              accountSid,
              traceId: rootSpan.traceId
            }, {
              ...(account.enable_debug_log && {level: 'debug'})
            });
            app.requestor.logger = app.notifier.logger = sipLogger;
            const callInfo = new CallInfo({
              direction: CallDirection.Outbound,
              req: inviteReq,
              to,
              tag: app.tag,
              callSid,
              accountSid: req.body.account_sid,
              applicationSid: app.application_sid,
              traceId: rootSpan.traceId
            });
            cs = new RestCallSession({
              logger: sipLogger,
              application: app,
              srf,
              req: inviteReq,
              ep,
              ep2: dualEp,
              tasks,
              callInfo,
              accountInfo,
              rootSpan
            });
            cs.exec(req);

            res.status(201).json({sid: cs.callSid, callId: inviteReq.get('Call-ID')});

            sipLogger.info({sid: cs.callSid, callId: inviteReq.get('Call-ID')},
              `outbound REST call attempt to ${JSON.stringify(target)} has been sent`);
          },
          cbProvisional: (prov) => {
            const callStatus = prov.body ? CallStatus.EarlyMedia : CallStatus.Ringing;
            // Update call-id for sbc outbound INVITE
            cs.callInfo.sbcCallid = prov.get('X-CID');
            if ([180, 183].includes(prov.status) && prov.body) connectStream(prov.body);
            restDial.emit('callStatus', prov.status, !!prov.body);
            cs.emit('callStatusChange', {callStatus, sipStatus: prov.status});
          }
        });
        connectStream(dlg.remote.sdp);
        cs.emit('callStatusChange', {
          callStatus: CallStatus.InProgress,
          sipStatus: 200,
          sipReason: 'OK'
        });
        restDial.emit('callStatus', 200);
        restDial.emit('connect', dlg);
      }
      catch (err) {
        let callStatus = CallStatus.Failed;
        if (err instanceof SipError) {
          if ([486, 603].includes(err.status)) callStatus = CallStatus.Busy;
          else if (487 === err.status) callStatus = CallStatus.NoAnswer;
          if (sipLogger) sipLogger.info(`REST outdial failed with ${err.status}`);
          else console.log(`REST outdial failed with ${err.status}`);
          if (cs) cs.emit('callStatusChange', {
            callStatus,
            sipStatus: err.status,
            sipReason: err.reason
          });
          cs.callGone = true;
        }
        else {
          if (cs) cs.emit('callStatusChange', {
            callStatus,
            sipStatus: 500,
            sipReason: 'Internal Server Error'
          });
          if (sipLogger) sipLogger.error({err}, 'REST outdial failed');
          else console.error(err);
        }
        ep.destroy();
        if (dualEp) {
          dualEp.destroy();
        }
        setTimeout(restDial.kill.bind(restDial, cs), 5000);
      }
    } catch (err) {
      sysError(logger, res, err);
    }
  });

module.exports = router;
