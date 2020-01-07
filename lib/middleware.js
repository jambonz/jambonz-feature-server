const debug = require('debug')('jambonz:feature-server');
const assert = require('assert');
const request = require('request');
//require('request-debug')(request);
const uuidv4 = require('uuid/v4');
const makeTask = require('./tasks/make_task');

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
    const call_sid = uuidv4();
    const account_sid = req.locals.application.account_sid;
    const application_sid = req.locals.application.application_sid;
    try {
      const app = req.locals.application;
      assert(app && app.call_hook);
      request.post({
        url: app.call_hook,
        json: true,
        body: req.msg
      }, (err, response, body) => {
        if (err) {
          logger.error(err, `Error invoking callback ${app.call_hook}`);
          return res.send(603, 'Bad webhook');
        }
        logger.debug(body, 'application payload');
        const taskData = Array.isArray(body) ? body : [body];
        app.tasks = [];
        for (const t in taskData) {
          try {
            const task = makeTask(logger, taskData[t]);
            app.tasks.push(task);
          } catch (err) {
            logger.info({data: taskData[t]}, `invalid web callback payload: ${err.message}`);
            res.send(500, 'Application Error', {
              headers: {
                'X-Reason': err.message
              }
            });
            break;
          }
        }
        if (!res.finalResponseSent) next();
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
