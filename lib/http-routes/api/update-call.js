const router = require('express').Router();
const sysError = require('./error');
const sessionTracker = require('../../session/session-tracker');

router.post('/:callSid', async(req, res) => {
  const logger = req.app.locals.logger;
  const callSid = req.params.callSid;
  logger.debug({body: req.body}, 'got upateCall request');
  try {
    const cs = sessionTracker.get(callSid);
    if (!cs) {
      logger.info(`updateCall: callSid not found ${callSid}`);
      return res.sendStatus(404);
    }
    res.sendStatus(202);
    cs.updateCall(req.body);
  } catch (err) {
    sysError(logger, res, err);
  }
});

module.exports = router;
