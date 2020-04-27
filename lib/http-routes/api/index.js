const api = require('express').Router();

api.use('/createCall', require('./create-call'));
api.use('/updateCall', require('./update-call'));
api.use('/startConference', require('./start-conference'));

// health checks
api.get('/', (req, res) => res.sendStatus(200));
api.get('/health', (req, res) => res.sendStatus(200));

module.exports = api;
