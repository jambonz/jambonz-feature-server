const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const bent = require('bent');
const { v4: uuidv4 } = require('uuid');

class TaskMessage extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.None;

    this.payload = {
      message_sid: this.data.message_sid || uuidv4(),
      provider: this.data.provider,
      to: this.data.to,
      from: this.data.from,
      text: this.data.text
    };

  }

  get name() { return TaskName.Message; }

  /**
   * Send outbound SMS
   */
  async exec(cs) {
    const {srf, accountSid} = cs;
    const {res} = cs.callInfo;
    let payload = this.payload;
    await super.exec(cs);
    try {
      const {getSmpp, dbHelpers} = srf.locals;
      const {lookupSmppGateways} = dbHelpers;

      this.logger.info(`looking up gateways for account_sid: ${accountSid}`);
      const r = await lookupSmppGateways(accountSid);
      let gw, url, relativeUrl;
      if (r.length > 0) {
        gw = r.find((o) => 1 === o.sg.outbound && (!this.payload.provider || o.vc.name === this.payload.provider));
      }
      if (gw) {
        this.logger.info({gw, accountSid}, 'Message:exec - using smpp to send message');
        url = getSmpp();
        relativeUrl = '/sms';
        payload = {
          ...payload,
          ...gw.sg,
          ...gw.vc
        };
      }
      else {
        //TMP: smpp only at the moment, need to add http back in
        /*
        this.logger.info({gw, accountSid, provider: this.payload.provider},
          'Message:exec - no smpp gateways found to send message');
        relativeUrl = 'v1/outboundSMS';
        const sbcAddress = getSBC();
        if (sbcAddress) url = `http://${sbcAddress}:3000/`;
        */
        return res.sendStatus(404);
      }
      if (url) {
        const post = bent(url, 'POST', 'json', 201);
        this.logger.info({payload, url}, 'Message:exec sending outbound SMS');
        const response = await post(relativeUrl, payload);
        this.logger.info({response}, 'Successfully sent SMS');
        if (cs.callInfo.res) {
          this.logger.info('Message:exec sending 200 OK response to HTTP POST from api server');
          res.status(200).json({
            sid: cs.callInfo.messageSid,
            providerResponse: response
          });
        }

        // TODO: action Hook
      }
      else {
        this.logger.info('Message:exec - unable to send SMS as there are no available SMS gateways');
        res.status(422).json({message: 'no configured SMS gateways'});
      }
    } catch (err) {
      this.logger.error(err, 'TaskMessage:exec - Error sending SMS');
      res.status(422).json({message: 'no configured SMS gateways'});
    }
  }
}

module.exports = TaskMessage;
