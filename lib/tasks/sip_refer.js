const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

/**
 * sends a sip REFER to transfer the existing call
 */
class TaskSipRefer extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.StableCall;

    this.referTo = this.data.referTo;
    this.referredBy = this.data.referredBy;
    this.headers = this.data.headers || {};
  }

  get name() { return TaskName.SipRefer; }

  async exec(cs) {
    super.exec(cs);
    const {dlg} = cs;
    const {referTo, referredBy} = this._normalizeReferHeaders(dlg);

    try {
      this.notifyHandler = this._handleNotify.bind(this, dlg);
      dlg.on('notify', this.notifyHandler);
      const response = await dlg.request({
        method: 'REFER',
        headers: {
          ...this.headers,
          'Refer-To': referTo,
          'Referred-By': referredBy
        }
      });
      this.referStatus = response.status;
      this.logger.info(`TaskSipRefer:exec - received ${this.referStatus} to REFER`);
      await this.performAction({status: this.referStatus});

      //if (response.status === 202) this.awaitTaskDone();
    } catch (err) {
      this.logger.info({err}, 'TaskSipRefer:exec - error sending REFER');
    }
  }

  async kill(cs) {
    super.kill(cs);
    const {dlg} = cs;
    dlg.removeEventListener('notify', this.notifyHandler);
  }

  async _handleNotify(dlg, req, res) {
    const contentType = req.get('Content-Type');
    this.logger.info({body: req.body}, `TaskSipRefer:_handleNotify got ${contentType}`);
    res.send(200);
  }

  _normalizeReferHeaders(dlg) {
    let {referTo, referredBy} = this;

    if (!referTo.startsWith('<') && !referTo.startsWith('sip') && !referTo.startsWith('"')) {
      /* they may have only provided a phone number/user */
      referTo = `sip:${referTo}@localhost`;
    }
    if (!referredBy) {
      /* default */
      referredBy = dlg.local.uri;
    }
    else if (!referredBy.startsWith('<') && !referredBy.startsWith('sip') && !referredBy.startsWith('"')) {
      /* they may have only provided a phone number/user */
      referredBy = `sip:${referredBy}@localhost`;
    }
  }
}

module.exports = TaskSipRefer;
