const router = require('express').Router();
const sysError = require('./error');
const sessionTracker = require('../../session/session-tracker');
const {TaskName} = require('../../utils/constants.json');
const {DbErrorUnprocessableRequest} = require('../utils/errors');

/**
 * validate the call state
 */
function retrieveCallSession(callSid, opts) {
  const cs = sessionTracker.get(callSid);
  if (cs) {
    const task = cs.currentTask;
    if (!task || task.name != TaskName.Enqueue) {
      throw new DbErrorUnprocessableRequest(`enqueue api failure: indicated call is not queued: ${task.name}`);
    }
  }
  return cs;
}

/**
 * notify a waiting session that a conference has started
 */
router.post('/:callSid', async(req, res) => {
  const logger = req.app.locals.logger;
  const callSid = req.params.callSid;
  logger.debug({body: req.body}, 'got enqueue event');
  try {
    const cs = retrieveCallSession(callSid, req.body);
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
