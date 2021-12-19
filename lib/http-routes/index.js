const express = require('express');
const api = require('./api');
const routes = express.Router();
const sessionTracker = require('../session/session-tracker');

const readiness = (req, res) => {
  const logger = req.app.locals.logger;
  const {count} = sessionTracker;
  const {srf} = require('../..');
  const {getFreeswitch} = srf.locals;
  if (getFreeswitch()) {
    return res.status(200).json({calls: count});
  }
  logger.info('responding to /health check with failure as freeswitch is not up');
  res.sendStatus(480);
};

routes.use('/v1', api);

// health check
routes.get('/health', readiness);

module.exports = routes;
