const router = require('express').Router();
const sessionTracker = require('../../session/session-tracker');

router.get('/', async(req, res) => {
  const logger = req.app.locals.logger;
  const {count} = sessionTracker;
  logger.info(`responding to health check with call count ${count}`);
  res.status(200).json({calls: count});
});

module.exports = router;
