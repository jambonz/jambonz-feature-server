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
    throw new DbErrorBadRequest('call_status_hook can be updated only when call_hook is also being updated');
  }
  const cs = sessionTracker.get(callSid);

  if (opts.call_status === CallStatus.Completed && !cs.hasStableDialog) {
    throw new DbErrorUnprocessableRequest('current call state is incompatible with requested action');
  }
  else if (opts.call_status === CallStatus.NoAnswer) {
    if (cs.direction === CallDirection.Outbound) {
      if (!cs.isOutboundCallRinging) {
        throw new DbErrorUnprocessableRequest('current call state is incompatible with requested action');
      }
    }
    else {
      if (cs.isInboundCallAnswered) {
        throw new DbErrorUnprocessableRequest('current call state is incompatible with requested action');
      }
    }
  }

  return cs;
}

const updateCall = async(req, res) => {
  const logger = req.app.locals.logger;
  const callSid = req.params.callSid;
  logger.debug({body: req.body}, 'got upateCall request');
  try {
    const cs = retrieveCallSession(callSid, req.body);
    if (!cs) {
      logger.info(`updateCall: callSid not found ${callSid}`);
      return res.sendStatus(404);
    }
    res.sendStatus(204);
    cs.updateCall(req.body, callSid);
  } catch (err) {
    sysError(logger, res, err);
  }
};

/**
 * update a call
 */

/* leaving in for legacy; should have been (and now is) a PUT */
router.post('/:callSid', async(req, res) => {
  await updateCall(req, res);
});
router.put('/:callSid', async(req, res) => {
  await updateCall(req, res);
});

module.exports = router;
