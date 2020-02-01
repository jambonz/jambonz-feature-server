const api = require('express').Router();

api.use('/createCall', require('./create-call'));

module.exports = api;
