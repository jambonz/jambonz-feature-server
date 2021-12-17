const api = require('express').Router();

api.use('/createCall', require('./create-call'));
api.use('/updateCall', require('./update-call'));
api.use('/conference', require('./conference'));
api.use('/dequeue', require('./dequeue'));
api.use('/enqueue', require('./enqueue'));

api.use('/messaging', require('./messaging'));            // inbound SMS
api.use('/createMessage', require('./create-message'));   // outbound SMS (REST)

module.exports = api;
