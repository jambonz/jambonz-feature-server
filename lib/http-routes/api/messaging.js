const router = require('express').Router();
const HttpRequestor = require('../../utils/http-requestor');
const WsRequestor = require('../../utils/ws-requestor');
const CallInfo = require('../../session/call-info');
const {CallDirection} = require('../../utils/constants');
const SmsSession = require('../../session/sms-call-session');
const normalizeJambones = require('../../utils/normalize-jambones');
const {TaskPreconditions} = require('../../utils/constants');
const makeTask = require('../../tasks/make_task');

router.post('/:partner', async(req, res) => {
  const {logger} = req.app.locals;

  logger.debug({body: req.body}, `got incomingSms request from partner ${req.params.partner}`);

  let tasks;
  const {srf} = require('../../..');
  const {lookupAccountBySid} = srf.locals.dbHelpers;
  const app = req.body.app;
  const account = await lookupAccountBySid(app.accountSid);
  const hook = app.messaging_hook;
  let requestor;

  if ('WS' === hook?.method) {
    app.requestor = new WsRequestor(logger, account.account_sid, hook, account.webhook_secret) ;
    app.notifier = app.requestor;
  }
  else {
    app.requestor = new HttpRequestor(logger, account.account_sid, hook, account.webhook_secret);
    app.notifier = {request: () => {}};
  }

  const payload = {
    carrier: req.params.partner,
    messageSid: app.messageSid,
    accountSid: app.accountSid,
    serviceProviderSid: account.service_provider_sid,
    applicationSid: app.applicationSid,
    from: req.body.from,
    to: req.body.to,
    cc: req.body.cc,
    text: req.body.text,
    media: req.body.media
  };
  res.status(200).json({sid: req.body.messageSid});

  try {
    tasks = await requestor.request('session:new', hook, payload);
    logger.info({tasks}, 'response from incoming SMS webhook');
  } catch (err) {
    logger.error({err, hook}, 'Error sending incoming SMS message');
    return;
  }


  // process any verbs in response
  if (Array.isArray(tasks) && tasks.length) {
    const {srf} = req.app.locals;

    app.requestor = requestor;
    app.notifier = {request: () => {}};

    try {
      tasks = normalizeJambones(logger, tasks)
        .map((tdata) => makeTask(logger, tdata))
        .filter((t) => t.preconditions === TaskPreconditions.None);

      if (0 === tasks.length) {
        logger.info('inboundSMS: after removing invalid verbs there are no tasks left to execute');
        return;
      }
      const callInfo = new CallInfo({
        direction: CallDirection.None,
        messageSid: app.messageSid,
        accountSid: app.accountSid,
        applicationSid: app.applicationSid
      });
      const cs = new SmsSession({logger, srf, application: app, tasks, callInfo});
      cs.exec();
    } catch (err) {
      logger.error({err, tasks}, 'InboundSMS: error launching SmsCallSession');
    }
  }
});

module.exports = router;
