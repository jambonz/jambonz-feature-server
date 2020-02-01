const express = require('express');
const api = require('./api');
const routes = express.Router();

routes.use('/v1', api);

// health checks
routes.get('/', (req, res) => {
  res.sendStatus(200);
});

routes.get('/health', (req, res) => {
  res.sendStatus(200);
});

module.exports = routes;
