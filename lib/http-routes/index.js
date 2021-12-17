const express = require('express');
const api = require('./api');
const routes = express.Router();
const sessionTracker = require('../session/session-tracker');

const health = (req, res) => {
  const logger = req.app.locals.logger;
  const {count} = sessionTracker;
  logger.info(`responding to health check with call count ${count}`);
  res.status(200).json({calls: count});
};

routes.use('/v1', api);

// health checks
routes.get('/', health);
routes.get('/health', health);


module.exports = routes;
