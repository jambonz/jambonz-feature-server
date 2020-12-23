const { v4: uuidv4 } = require('uuid');
const {CallDirection} = require('./utils/constants');
const CallInfo = require('./session/call-info');
const Requestor = require('./utils/requestor');
const makeTask = require('./tasks/make_task');
const parseUri = require('drachtio-srf').parseUri;
const normalizeJambones = require('./utils/normalize-jambones');

module.exports = function(srf, logger) {
  const {lookupAppByPhoneNumber, lookupAppBySid, lookupAppByRealm, lookupAppByTeamsTenant}  = srf.locals.dbHelpers;

  function initLocals(req, res, next) {
    const callSid = req.has('X-Retain-Call-Sid') ? req.get('X-Retain-Call-Sid') : uuidv4();
    req.locals = {
      callSid,
      logger: logger.child({callId: req.get('Call-ID'), callSid})
    };
    if (req.has('X-Application-Sid')) {
      const application_sid = req.get('X-Application-Sid');
      req.locals.logger.debug(`got application from X-Application-Sid header: ${application_sid}`);
      req.locals.application_sid = application_sid;
    }
    if (req.has('X-Authenticated-User')) req.locals.originatingUser = req.get('X-Authenticated-User');
    if (req.has('X-MS-Teams-Tenant-FQDN')) req.locals.msTeamsTenant = req.get('X-MS-Teams-Tenant-FQDN');

    next();
  }

  /**
   * Within the system, we deal with E.164 numbers _without_ the leading '+
   */
  function normalizeNumbers(req, res, next) {
    const logger = req.locals.logger;
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
        const arr = /context-(.*)/.exec(uri.user);
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
        else app = await lookupAppByPhoneNumber(req.locals.calledNumber);
      }

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
      app.requestor = new Requestor(logger, app.call_hook);
      if (app.call_status_hook) app.notifier = new Requestor(logger, app.call_status_hook);
      else app.notifier = {request: () => {}};

      req.locals.application = app;
      const obj = Object.assign({}, app);
      delete obj.requestor;
      delete obj.notifier;
      logger.info({app: obj}, `retrieved application for incoming call to ${req.locals.calledNumber}`);
      req.locals.callInfo = new CallInfo({req, app, direction: CallDirection.Inbound});
      next();
    } catch (err) {
      logger.error(err, `${req.get('Call-ID')} Error looking up application for ${req.calledNumber}`);
      res.send(500);
    }
  }

  /**
   * Invoke the application callback and get the initial set of instructions
   */
  async function invokeWebCallback(req, res, next) {
    const logger = req.locals.logger;
    const app = req.locals.application;
    try {

      if (app.tasks) {
        app.tasks = normalizeJambones(logger, app.tasks).map((tdata) => makeTask(logger, tdata));
        if (0 === app.tasks.length) throw new Error('no application provided');
        return next();
      }
      /* retrieve the application to execute for this inbound call */
      const params = Object.assign(app.call_hook.method === 'POST' ? {sip: req.msg} : {},
        req.locals.callInfo);
      const json = await app.requestor.request(app.call_hook, params);
      app.tasks = normalizeJambones(logger, json).map((tdata) => makeTask(logger, tdata));
      if (0 === app.tasks.length) throw new Error('no application provided');
      next();
    } catch (err) {
      logger.info(`Error retrieving or parsing application: ${err.message}`);
      res.send(480, {headers: {'X-Reason': err.message}});
    }
  }

  return {
    initLocals,
    normalizeNumbers,
    retrieveApplication,
    invokeWebCallback
  };
};
