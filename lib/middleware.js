//const debug = require('debug')('jambonz:feature-server');
const uuidv4 = require('uuid/v4');
const {CallStatus, CallDirection} = require('./utils/constants');
const CallInfo = require('./session/call-info');
const retrieveApp = require('./utils/retrieve-app');

module.exports = function(srf, logger) {
  const {lookupAppByPhoneNumber}  = srf.locals.dbHelpers;

  function initLocals(req, res, next) {
    const callSid = uuidv4();
    req.locals = {
      callSid,
      logger: logger.child({callId: req.get('Call-ID'), callSid})
    };
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
      const app = await lookupAppByPhoneNumber(req.locals.calledNumber);
      if (!app) {
        logger.info(`rejecting call to DID ${req.locals.calledNumber}: no application associated`);
        return res.send(480, {
          headers: {
            'X-Reason': 'no configured application'
          }
        });
      }

      //TODO: temp hack pre-refactoring to latest db schema: bang the data into expected shape

      req.locals.application = app;
      //end hack
      logger.debug(app, `retrieved application for ${req.locals.calledNumber}`);
      const from = req.getParsedHeader('From');
      req.locals.callInfo = new CallInfo({
        callSid: req.locals.callSid,
        accountSid: app.account_sid,
        applicationSid: app.application_sid,
        from: req.callingNumber,
        to: req.calledNumber,
        direction: CallDirection.Inbound,
        callerName: from.name || req.callingNumber,
        callId: req.get('Call-ID')
      });
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
    const method = (app.hook_http_method || 'POST').toUpperCase();
    const qs = Object.assign({}, req.locals.callInfo, {
      sipStatus: 100,
      callStatus: CallStatus.Trying,
      originatingSipIP: req.get('X-Forwarded-For'),
      originatingSipTrunkName: req.get('X-Originating-Carrier')
    });
    let auth;
    if (app.hook_basic_auth_user && app.hook_basic_auth_password) {
      logger.debug(`using basic auth with ${app.hook_basic_auth_user}:${app.hook_basic_auth_password}`);
      auth = Object.assign({}, {user: app.hook_basic_auth_user, password: app.hook_basic_auth_password});
    }
    try {
      app.tasks = await retrieveApp(logger, app.call_hook, method, auth, qs, method === 'POST' ? req.msg : null);
      next();
    } catch (err) {
      logger.error(err, 'Error retrieving or parsing application');
      res.send(500);
    }
  }

  return {
    initLocals,
    normalizeNumbers,
    retrieveApplication,
    invokeWebCallback
  };
};
