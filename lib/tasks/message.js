const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const bent = require('bent');
const uuidv4 = require('uuid-random');

class TaskMessage extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.None;

    this.payload = {
      message_sid: this.data.message_sid || uuidv4(),
      carrier: this.data.carrier,
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
    const actionParams = {message_sid: this.payload.message_sid};

    await super.exec(cs);
    try {
      const {getSmpp, dbHelpers} = srf.locals;
      const {lookupSmppGateways} = dbHelpers;

      this.logger.debug(`looking up gateways for account_sid: ${accountSid}`);
      const r = await lookupSmppGateways(accountSid);
      let gw, url, relativeUrl;
      if (r.length > 0) {
        gw = r.find((o) => 1 === o.sg.outbound && (!this.payload.carrier || o.vc.name === this.payload.carrier));
      }
      if (gw) {
        this.logger.info({gw, accountSid}, 'Message:exec - using smpp to send message');
        url = process.env.K8S ? 'http://smpp' : getSmpp();
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
        this.logger.info({gw, accountSid, carrier: this.payload.carrier},
          'Message:exec - no smpp gateways found to send message');
        relativeUrl = 'v1/outboundSMS';
        const sbcAddress = getSBC();
        if (sbcAddress) url = `http://${sbcAddress}:3000/`;
        */
        this.performAction({
          ...actionParams,
          message_status: 'no carriers'
        }).catch((err) => {});
        if (res) res.sendStatus(404);
        return;
      }
      if (url) {
        const post = bent(url, 'POST', 'json', 201, 480);
        this.logger.info({payload, url}, 'Message:exec sending outbound SMS');
        const response = await post(relativeUrl, payload);
        const {smpp_err_code, carrier, message_id, message} = response;
        if (smpp_err_code) {
          this.logger.info({response}, 'SMPP error sending SMS');
          this.performAction({
            ...actionParams,
            carrier,
            carrier_message_id: message_id,
            message_status: 'failure',
            message_failure_reason: message
          }).catch((err) => {});
          if (res) {
            res.status(480).json({
              ...response,
              sid: cs.callInfo.messageSid
            });
          }
        }
        else {
          const {message_id, carrier} = response;
          this.logger.info({response}, 'Successfully sent SMS');
          this.performAction({
            ...actionParams,
            carrier,
            carrier_message_id: message_id,
            message_status: 'success',
          }).catch((err) => {});
          if (res) {
            res.status(200).json({
              sid: cs.callInfo.messageSid,
              carrierResponse: response
            });
          }
        }
      }
      else {
        this.logger.info('Message:exec - unable to send SMS as SMPP is not configured on the system');
        this.performAction({
          ...actionParams,
          message_status: 'smpp configuration error'
        }).catch((err) => {});
        if (res) res.status(404).json({message: 'no configured SMS gateways'});
      }
    } catch (err) {
      this.logger.error(err, 'TaskMessage:exec - unexpected error sending SMS');
      this.performAction({
        ...actionParams,
        message_status: 'system error',
        message_failure_reason: err.message
      });
      if (res) res.status(422).json({message: 'no configured SMS gateways'});
    }
  }
}

module.exports = TaskMessage;
