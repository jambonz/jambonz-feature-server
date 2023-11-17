const router = require('express').Router();
const sysError = require('./error');
const sessionTracker = require('../../session/session-tracker');
const {DbErrorBadRequest, DbErrorUnprocessableRequest} = require('../utils/errors');
const {CallStatus, CallDirection} = require('../../utils/constants');

/**
 * validate the payload and retrieve the CallSession for the CallSid
 */
function retrieveCallSession(callSid, opts) {
  if (opts.call_status_hook && !opts.call_hook) {
    throw new DbErrorBadRequest(
      `call_status_hook can be updated only when call_hook is also being updated for call_sid ${callSid}`);
  }
  const cs = sessionTracker.get(callSid);
  if (!cs) {
    throw new DbErrorUnprocessableRequest(`call session is gone for call_sid ${callSid}`);
  }

  if (opts.call_status === CallStatus.Completed && !cs.hasStableDialog) {
    throw new DbErrorUnprocessableRequest(
      `current call state is incompatible with requested action for call_sid ${callSid}`);
  }
  else if (opts.call_status === CallStatus.NoAnswer) {
    if (cs.direction === CallDirection.Outbound) {
      if (!cs.isOutboundCallRinging) {
        throw new DbErrorUnprocessableRequest(
          `current call state is incompatible with requested action for call_sid ${callSid}`);
      }
    }
    else {
      if (cs.isInboundCallAnswered) {
        throw new DbErrorUnprocessableRequest(
          `current call state is incompatible with requested action for call_sid ${callSid}`);
      }
    }
  }

  return cs;
}

/**
 * update a call
 */
router.post('/:callSid', async(req, res) => {
  const logger = req.app.locals.logger;
  const callSid = req.params.callSid;
  logger.debug({body: req.body}, 'got updateCall request');
  try {
    const cs = retrieveCallSession(callSid, req.body);
    if (!cs) {
      logger.info(`updateCall: callSid not found ${callSid}`);
      return res.sendStatus(404);
    }

    if (req.body.sip_request) {
      const response = await cs.updateCall(req.body, callSid);
      res.status(200).json({
        status: response.status,
        reason: response.reason
      });
    }
    else {
      res.sendStatus(202);
      cs.updateCall(req.body, callSid);
    }
  } catch (err) {
    sysError(logger, res, err);
  }
});

module.exports = router;
