//const debug = require('debug')('jambonz:feature-server');
const uuidv4 = require('uuid/v4');
const {CallDirection} = require('./utils/constants');
const CallInfo = require('./session/call-info');
const retrieveApp = require('./utils/retrieve-app');
const parseUrl = require('parse-url');

module.exports = function(srf, logger) {
  const {lookupAppByPhoneNumber, lookupApplicationBySid}  = srf.locals.dbHelpers;

  function initLocals(req, res, next) {
    const callSid = uuidv4();
    req.locals = {
      callSid,
      logger: logger.child({callId: req.get('Call-ID'), callSid})
    };
    if (req.has('X-Application-Sid')) {
      const application_sid = req.get('X-Application-Sid');
      req.locals.logger.debug(`got application from X-Application-Sid header: ${application_sid}`);
      req.locals.application_sid = application_sid;
    }
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
      if (req.locals.application_sid) {
        app = await lookupApplicationBySid(req.locals.application_sid);
      }
      else {
        app = await lookupAppByPhoneNumber(req.locals.calledNumber);
      }
      if (!app || !app.call_hook || !app.call_hook.url) {
        logger.info(`rejecting call to ${req.locals.calledNumber}: no application or webhook url`);
        return res.send(480, {
          headers: {
            'X-Reason': 'no configured application'
          }
        });
      }

      req.locals.application = app;
      logger.debug(app, `retrieved application for ${req.locals.calledNumber}`);
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
    const call_hook = app.call_hook;
    const method = call_hook.method.toUpperCase();
    let auth;
    if (call_hook.username && call_hook.password) {
      auth = {username: call_hook.username, password: call_hook.password};
    }
    try {
      const u = parseUrl(call_hook.url);
      const myPort = u.port ? `:${u.port}` : '';
      app.originalRequest = {
        baseUrl: `${u.protocol}://${u.resource}${myPort}`,
        auth,
        method
      };
      logger.debug({url: call_hook.url, method}, 'invokeWebCallback');
      const obj = Object.assign({}, req.locals.callInfo);

      // if the call hook is a POST add the entire SIP message to the payload
      if (method === 'POST') obj.sip = req.msg;
      app.tasks = await retrieveApp(logger, call_hook.url, method, auth, obj);
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
