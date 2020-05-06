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
    if (!task || task.name != TaskName.Dequeue) {
      throw new DbErrorUnprocessableRequest(`dequeue api failure: indicated call is not queued: ${task.name}`);
    }
  }
  return cs;
}

/**
 * notify a session in a dequeue verb of an event
 */
router.post('/:callSid', async(req, res) => {
  const logger = req.app.locals.logger;
  const callSid = req.params.callSid;
  logger.debug({body: req.body}, 'got dequeue event');
  try {
    const cs = retrieveCallSession(callSid, req.body);
    if (!cs) {
      logger.info(`dequeue: callSid not found ${callSid}`);
      return res.sendStatus(404);
    }
    res.status(202).end();
    cs.notifyDequeueEvent(req.body);
  } catch (err) {
    sysError(logger, res, err);
  }
});

module.exports = router;
