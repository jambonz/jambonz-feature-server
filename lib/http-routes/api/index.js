const api = require('express').Router();

api.use('/createCall', require('./create-call'));
api.use('/updateCall', require('./update-call'));

module.exports = api;
