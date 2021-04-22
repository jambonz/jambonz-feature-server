const router = require('express').Router();
const sysError = require('./error');
const sessionTracker = require('../../session/session-tracker');
const {TaskName} = require('../../utils/constants.json');
const {DbErrorUnprocessableRequest} = require('../utils/errors');

/**
 * validate the call state
 */
function retrieveCallSession(logger, callSid, opts) {
  logger.debug(`retrieving session for callSid ${callSid}`);
  const cs = sessionTracker.get(callSid);
  if (cs) {
    const task = cs.currentTask;
    if (!task || task.name != TaskName.Enqueue) {
      logger.debug({cs}, 'found call session but not in Enqueue task??');
      throw new DbErrorUnprocessableRequest(`enqueue api failure: indicated call is not queued: ${task.name}`);
    }
  }
  return cs;
}

/**
 * notify a waiting session that a queue event has occurred
 */
router.post('/:callSid', async(req, res) => {
  const logger = req.app.locals.logger;
  const callSid = req.params.callSid;
  logger.debug({callSid, body: req.body}, 'got enqueue event');
  try {
    const cs = retrieveCallSession(logger, callSid, req.body);
    if (!cs) {
      logger.info(`enqueue: callSid not found ${callSid}`);
      return res.sendStatus(404);
    }
    res.status(202).end();
    cs.notifyEnqueueEvent(req.body);
  } catch (err) {
    sysError(logger, res, err);
  }
});

module.exports = router;
