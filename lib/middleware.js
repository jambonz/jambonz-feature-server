//const debug = require('debug')('jambonz:feature-server');
const assert = require('assert');
const request = require('request');
//require('request-debug')(request);
const uuidv4 = require('uuid/v4');
const makeTask = require('./tasks/make_task');
const normalizeJamones = require('./utils/normalize-jamones');
const {CallStatus, CallDirection} = require('./utils/constants');

module.exports = function(srf, logger) {
  const {lookupAppByPhoneNumber}  = srf.locals.dbHelpers;

  function initLocals(req, res, next) {
    req.locals = req.locals || {};
    req.locals.logger = logger.child({callId: req.get('Call-ID')});
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
      const app = req.locals.application = await lookupAppByPhoneNumber(req.locals.calledNumber);
      if (!app) {
        logger.info(`rejecting call to DID ${req.locals.calledNumber}: no application associated`);
        return res.send(480, {
          headers: {
            'X-Reason': 'no configured application'
          }
        });
      }
      logger.debug(app, `retrieved application for ${req.locals.calledNumber}`);
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
    const call_sid = uuidv4();
    const method = (app.hook_http_method || 'POST').toUpperCase();
    const from = req.getParsedHeader('From');
    req.locals.callAttributes = {
      CallSid:  call_sid,
      AccountSid: app.account_sid,
      From: req.callingNumber,
      To: req.calledNumber,
      Direction: CallDirection.Inbound,
      CallerName: from.name || req.callingNumber,
      SipCallID: req.get('Call-ID')
    };
    const qs = Object.assign({}, req.locals.callAttributes, {
      CallStatus: CallStatus.Trying,
      SipStatus: 100,
      RequestorIP: req.get('X-Forwarded-For'),
      RequestorName: req.get('X-Originating-Carrier')
    });
    const opts = {
      url: app.call_hook,
      method,
      json: true,
      qs
    };
    if (app.hook_basic_auth_user && app.hook_basic_auth_password) {
      logger.debug(`using basic auth with ${app.hook_basic_auth_user}:${app.hook_basic_auth_password}`);
      Object.assign(opts, {auth: {user: app.hook_basic_auth_user, password: app.hook_basic_auth_password}});
    }
    if (method === 'POST') Object.assign(opts, {body: req.msg});
    try {
      request(opts, (err, response, body) => {
        if (err) {
          logger.error(err, `Error invoking callback ${app.call_hook}`);
          return res.send(500, 'Webhook Failure');
        }
        logger.debug(body, `application payload: ${body}`);
        try {
          app.tasks = normalizeJamones(logger, body).map((tdata) => makeTask(logger, tdata));
          next();
        } catch (err) {
          logger.error(err, 'Invalid Webhook Response');
          res.send(500);
        }
      });
    } catch (err) {
      logger.error(err, 'Error invoking web callback');
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
