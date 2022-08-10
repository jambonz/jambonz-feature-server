const { v4: uuidv4 } = require('uuid');
const {CallDirection, AllowedSipRecVerbs} = require('./utils/constants');
const {parseSiprecPayload} = require('./utils/siprec-utils');
const CallInfo = require('./session/call-info');
const HttpRequestor = require('./utils/http-requestor');
const WsRequestor = require('./utils/ws-requestor');
const makeTask = require('./tasks/make_task');
const parseUri = require('drachtio-srf').parseUri;
const normalizeJambones = require('./utils/normalize-jambones');
const dbUtils = require('./utils/db-utils');
const RootSpan = require('./utils/call-tracer');
const listTaskNames = require('./utils/summarize-tasks');

module.exports = function(srf, logger) {
  const {
    lookupAppByPhoneNumber,
    lookupAppByRegex,
    lookupAppBySid,
    lookupAppByRealm,
    lookupAppByTeamsTenant
  }  = srf.locals.dbHelpers;
  const {lookupAccountDetails} = dbUtils(logger, srf);

  function initLocals(req, res, next) {
    if (!req.has('X-Account-Sid')) {
      logger.info('getAccountDetails - rejecting call due to missing X-Account-Sid header');
      return res.send(500);
    }
    const callSid = req.has('X-Retain-Call-Sid') ? req.get('X-Retain-Call-Sid') : uuidv4();
    const account_sid = req.get('X-Account-Sid');
    req.locals = {callSid, account_sid};
    if (req.has('X-Application-Sid')) {
      const application_sid = req.get('X-Application-Sid');
      logger.debug(`got application from X-Application-Sid header: ${application_sid}`);
      req.locals.application_sid = application_sid;
    }
    if (req.has('X-Authenticated-User')) req.locals.originatingUser = req.get('X-Authenticated-User');
    if (req.has('X-MS-Teams-Tenant-FQDN')) req.locals.msTeamsTenant = req.get('X-MS-Teams-Tenant-FQDN');

    next();
  }

  function createRootSpan(req, res, next) {
    const {callSid, account_sid} = req.locals;
    const rootSpan = new RootSpan('incoming-call', req);
    const traceId = rootSpan.traceId;

    req.locals = {
      ...req.locals,
      traceId,
      logger: logger.child({
        callId: req.get('Call-ID'),
        callSid,
        accountSid: account_sid,
        callingNumber: req.callingNumber,
        calledNumber: req.calledNumber,
        traceId}),
      rootSpan
    };

    /**
     * end the span on final failure or cancel from caller;
     * otherwise it will be closed when sip dialog is destroyed
    */
    req.once('cancel', () => {
      rootSpan.setAttributes({finalStatus: 487});
      rootSpan.end();
    });
    res.once('finish', () => {
      rootSpan.setAttributes({finalStatus: res.statusCode});
      res.statusCode >= 300 && rootSpan.end();
    });

    next();
  }

  const handleSipRec = async(req, res, next) => {
    if (Array.isArray(req.payload) && req.payload.length > 1) {
      const {callId, logger} = req.locals;
      logger.debug({payload: req.payload}, 'handling siprec call');

      try {
        const sdp = req.payload
          .find((p) => p.type === 'application/sdp')
          .content;
        const {sdp1, sdp2, ...metadata} = await parseSiprecPayload(req, logger);
        req.locals.calledNumber = metadata.caller.number;
        req.locals.callingNumber = metadata.callee.number;
        req.locals = {
          ...req.locals,
          siprec: {
            metadata,
            sdp1,
            sdp2
          }
        };
        logger.info({callId, metadata, sdp}, 'successfully parsed SIPREC payload');
      } catch (err) {
        logger.info({callId}, 'Error parsing multipart payload');
        return res.send(503);
      }
    }
    next();
  };

  /**
   * retrieve account information for the incoming call
   */
  async function getAccountDetails(req, res, next) {
    const {rootSpan, account_sid} = req.locals;

    const {span} = rootSpan.startChildSpan('lookupAccountDetails');
    try {
      req.locals.accountInfo = await lookupAccountDetails(account_sid);
      span.end();
      if (!req.locals.accountInfo.account.is_active) {
        logger.info(`Account is inactive or suspended ${account_sid}`);
        // TODO: alert
        return res.send(503, {headers: {'X-Reason': 'Account exists but is inactive'}});
      }
      logger.debug({accountInfo: req.locals?.accountInfo?.account}, `retrieved account info for ${account_sid}`);
      next();
    } catch (err) {
      span.end();
      logger.info({err}, `Error retrieving account details for account ${account_sid}`);
      res.send(503, {headers: {'X-Reason': `No Account exists for sid ${account_sid}`}});
    }
  }

  /**
   * Within the system, we deal with E.164 numbers _without_ the leading '+
   */
  function normalizeNumbers(req, res, next) {
    const {logger, siprec} = req.locals;

    if (siprec) return next();

    Object.assign(req.locals, {
      calledNumber: req.calledNumber,
      callingNumber: req.callingNumber
    });
    try {
      const regex = /^\+(\d+)$/;
      let arr = regex.exec(req.calledNumber);
      if (arr) req.locals.calledNumber = arr[1];
      arr = regex.exec(req.callingNumber);
      if (arr) req.locals.callingNumber = arr[1];
    } catch (err) {
      logger.error(err, `${req.get('Call-ID')} Error performing regex`);
    }
    next();
  }

  /**
   * Given the dialed DID/phone number, retrieve the application to invoke
   */
  async function retrieveApplication(req, res, next) {
    const logger = req.locals.logger;
    const {accountInfo, account_sid, rootSpan} = req.locals;
    const {span} = rootSpan.startChildSpan('lookupApplication');
    try {
      let app;
      if (req.locals.application_sid) app = await lookupAppBySid(req.locals.application_sid);
      else if (req.locals.originatingUser) {
        const arr = /^(.*)@(.*)/.exec(req.locals.originatingUser);
        if (arr) {
          const sipRealm = arr[2];
          logger.debug(`looking for device calling app for realm ${sipRealm}`);
          app = await lookupAppByRealm(sipRealm);
          if (app) logger.debug({app}, `retrieved device calling app for realm ${sipRealm}`);

        }
      }
      else if (req.locals.msTeamsTenant) {
        app = await lookupAppByTeamsTenant(req.locals.msTeamsTenant);
        if (app) logger.debug({app}, `retrieved app for ms teams tenant ${req.locals.msTeamsTenant}`);
      }
      else {
        const uri = parseUri(req.uri);
        const arr = /context-(.*)/.exec(uri?.user);
        if (arr) {
          // this is a transfer from another feature server
          const {retrieveKey, deleteKey} = srf.locals.dbHelpers;
          try {
            const obj = JSON.parse(await retrieveKey(arr[1]));
            logger.info({obj}, 'retrieved application and tasks for a transferred call from realtimedb');
            app = Object.assign(obj, {transferredCall: true});
            deleteKey(arr[1]).catch(() => {});
          } catch (err) {
            logger.error(err, `Error retrieving transferred call app for ${arr[1]}`);
          }
        }
        else {
          const voip_carrier_sid = req.get('X-Voip-Carrier-Sid');
          app = await lookupAppByPhoneNumber(req.locals.calledNumber, voip_carrier_sid);

          if (!app) {
            /* lookup by call_routes.regex */
            app = await lookupAppByRegex(req.locals.calledNumber, account_sid);
          }
        }
      }

      span.setAttributes({
        'app.hook': app?.call_hook?.url,
        'application_sid': req.locals.application_sid
      });
      span.end();
      if (!app || !app.call_hook || !app.call_hook.url) {
        logger.info(`rejecting call to ${req.locals.calledNumber}: no application or webhook url`);
        return res.send(480, {
          headers: {
            'X-Reason': 'no configured application'
          }
        });
      }

      /**
      * create a requestor that we will use for all http requests we make during the call.
      * also create a notifier for call status events (if not needed, its a no-op).
      */
      if ('WS' === app.call_hook?.method ||
        app.call_hook?.url.startsWith('ws://') || app.call_hook?.url.startsWith('wss://')) {
        app.requestor = new WsRequestor(logger, account_sid, app.call_hook, accountInfo.account.webhook_secret) ;
        app.notifier = app.requestor;
        app.call_hook.method = 'WS';
      }
      else {
        app.requestor = new HttpRequestor(logger, account_sid, app.call_hook, accountInfo.account.webhook_secret);
        if (app.call_status_hook) app.notifier = new HttpRequestor(logger, account_sid, app.call_status_hook,
          accountInfo.account.webhook_secret);
        else app.notifier = {request: () => {}};
      }

      req.locals.application = app;
      const obj = Object.assign({}, app);
      delete obj.requestor;
      delete obj.notifier;
      // eslint-disable-next-line no-unused-vars
      const {call_hook, call_status_hook, ...appInfo} = obj;  // mask sensitive data like user/pass on webhook
      logger.info({app: appInfo}, `retrieved application for incoming call to ${req.locals.calledNumber}`);
      req.locals.callInfo = new CallInfo({
        req,
        app,
        direction: CallDirection.Inbound,
        traceId: rootSpan.traceId
      });
      next();
    } catch (err) {
      span.end();
      logger.error(err, `${req.get('Call-ID')} Error looking up application for ${req.calledNumber}`);
      res.send(500);
    }
  }

  /**
   * Invoke the application callback and get the initial set of instructions
   */
  async function invokeWebCallback(req, res, next) {
    const logger = req.locals.logger;
    const {rootSpan, siprec, application:app} = req.locals;
    let span;
    try {
      if (app.tasks) {
        app.tasks = normalizeJambones(logger, app.tasks).map((tdata) => makeTask(logger, tdata));
        if (0 === app.tasks.length) throw new Error('no application provided');
        return next();
      }
      /* retrieve the application to execute for this inbound call */
      const params = Object.assign(['POST', 'WS'].includes(app.call_hook.method) ? {sip: req.msg} : {},
        req.locals.callInfo, {
          defaults: {
            synthesizer: {
              vendor: app.speech_synthesis_vendor,
              language: app.speech_synthesis_language,
              voice: app.speech_synthesis_voice
            },
            recognizer: {
              vendor: app.speech_recognizer_vendor,
              language: app.speech_recognizer_language
            }
          }
        });
      logger.debug({params}, 'sending initial webhook');
      const obj = rootSpan.startChildSpan('performAppWebhook');
      span = obj.span;
      const b3 = rootSpan.getTracingPropagation();
      const httpHeaders = b3 && {b3};
      const json = await app.requestor.request('session:new', app.call_hook, params, httpHeaders);
      app.tasks = normalizeJambones(logger, json).map((tdata) => makeTask(logger, tdata));
      span.setAttributes({
        'http.statusCode': 200,
        'app.tasks': listTaskNames(app.tasks)
      });
      span.end();
      if (0 === app.tasks.length) throw new Error('no application provided');

      if (siprec) {
        const tasks = app.tasks.filter((t) => AllowedSipRecVerbs.includes(t.name));
        if (0 === tasks.length) {
          logger.info({tasks: app.tasks}, 'no valid verbs in app found for an incoming siprec call');
          throw new Error('invalid verbs for incoming siprec call');
        }
        if (tasks.length < app.tasks.length) {
          logger.info('removing verbs that are not allowed for incoming siprec call');
          app.tasks = tasks;
        }
      }
      next();
    } catch (err) {
      span?.setAttributes({webhookStatus: err.statusCode});
      span?.end();
      logger.info({err}, `Error retrieving or parsing application: ${err?.message}`);
      res.send(480, {headers: {'X-Reason': err?.message || 'unknown'}});
      app.requestor.close();
    }
  }

  return {
    initLocals,
    createRootSpan,
    handleSipRec,
    getAccountDetails,
    normalizeNumbers,
    retrieveApplication,
    invokeWebCallback
  };
};
