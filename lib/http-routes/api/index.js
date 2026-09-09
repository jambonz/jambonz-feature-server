const api = require('express').Router();

api.use('/createCall', require('./create-call'));
api.use('/updateCall', require('./update-call'));
api.use('/conference', require('./conference'));
api.use('/dequeue', require('./dequeue'));
api.use('/enqueue', require('./enqueue'));

module.exports = api;
