const router = require('express').Router();
const CallInfo = require('../../session/call-info');
const {CallDirection} = require('../../utils/constants');
const SmsSession = require('../../session/sms-call-session');
const { normalizeJambones } = require('@jambonz/verb-specifications');
const makeTask = require('../../tasks/make_task');

router.post('/:sid', async(req, res) => {
  const {logger} = req.app.locals;
  const {srf} = req.app.locals;
  const {message_sid, account_sid} = req.body;

  logger.debug({body: req.body}, 'got createMessage request');

  const data = [{
    verb: 'message',
    ...req.body
  }];
  delete data[0].message_sid;

  try {
    const tasks = normalizeJambones(logger, data)
      .map((tdata) => makeTask(logger, tdata));

    const callInfo = new CallInfo({
      direction: CallDirection.None,
      messageSid: message_sid,
      accountSid: account_sid,
      res
    });
    const cs = new SmsSession({logger, srf, tasks, callInfo});
    cs.exec();
  } catch (err) {
    logger.error({err, body: req.body}, 'OutboundSMS: error launching SmsCallSession');
  }
});

module.exports = router;
