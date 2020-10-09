const router = require('express').Router();
const CallInfo = require('../../session/call-info');
const {CallDirection} = require('../../utils/constants');
const SmsSession = require('../../session/sms-call-session');
const normalizeJambones = require('../../utils/normalize-jambones');
const makeTask = require('../../tasks/make_task');

router.post('/:sid', async(req, res) => {
  const {logger} = req.app.locals;
  const {srf} = req.app.locals;
  const {messageSid} = req.body;

  logger.debug({body: req.body}, 'got createMessage request');

  const data = [Object.assign({verb: 'message'}, req.body)];
  delete data[0].messageSid;

  try {
    const tasks = normalizeJambones(logger, data)
      .map((tdata) => makeTask(logger, tdata));

    const callInfo = new CallInfo({
      direction: CallDirection.None,
      messageSid,
      accountSid: req.params.sid,
      res
    });
    const cs = new SmsSession({logger, srf, tasks, callInfo});
    cs.exec();
  } catch (err) {
    logger.error({err, body: req.body}, 'OutboundSMS: error launching SmsCallSession');
  }
});

module.exports = router;
