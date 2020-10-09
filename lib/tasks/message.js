const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const bent = require('bent');

class TaskMessage extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.None;

    this.payload = {
      provider: this.data.provider,
      to: this.data.to,
      from: this.data.from,
      cc: this.data.cc,
      text: this.data.text,
      media: this.data.media
    };

  }

  get name() { return TaskName.Message; }

  /**
   * Send outbound SMS
   */
  async exec(cs, dlg) {
    const {srf} = cs;
    await super.exec(cs);
    try {
      const {getSBC} = srf.locals;
      const sbcAddress = getSBC();
      if (sbcAddress) {
        const url = `http://${sbcAddress}:3000/`;
        const post = bent(url, 'POST', 'json', 200);
        this.logger.info({payload: this.payload, sbcAddress}, 'Message:exec sending outbound SMS');
        const response = await post('v1/outboundSMS', this.payload);
        this.logger.info({response}, 'Successfully sent SMS');
        if (cs.callInfo.res) {
          this.logger.info('Message:exec sending 200 OK response to HTTP POST from api server');
          cs.callInfo.res.status(200).json({
            sid: cs.callInfo.messageSid,
            providerResponse: response
          });
        }

        // TODO: action Hook
      }
      else {
        this.logger.info('Message:exec - unable to send SMS as there are no available SBCs');
      }
    } catch (err) {
      this.logger.error(err, 'TaskMessage:exec - Error sending SMS');
    }
  }
}

module.exports = TaskMessage;
