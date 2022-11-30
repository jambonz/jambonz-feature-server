const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const {parseUri} = require('drachtio-srf');

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
    this.eventHook = this.data.eventHook;
  }

  get name() { return TaskName.SipRefer; }

  async exec(cs) {
    super.exec(cs);
    const {dlg} = cs;
    const {referTo, referredBy} = this._normalizeReferHeaders(cs, dlg);

    try {
      this.notifyHandler = this._handleNotify.bind(this, cs, dlg);
      dlg.on('notify', this.notifyHandler);
      /* otel: trace time for tts */
      this.referSpan = this.startSpan('send-refer', {
        'refer.refer_to': referTo,
        'refer.referred_by': referredBy
      });

      const response = await dlg.request({
        method: 'REFER',
        headers: {
          ...this.headers,
          ...(this.referToIsUri && {'X-Refer-To-Leave-Untouched': true}),
          'Refer-To': referTo,
          'Referred-By': referredBy
        }
      });
      this.referStatus = response.status;
      this.referSpan.setAttributes({'refer.status_code': response.status});
      this.logger.info(`TaskSipRefer:exec - received ${this.referStatus} to REFER`);

      /* if we fail, fall through to next verb.  If success, we should get BYE from far end */
      if (this.referStatus === 202) {
        await this.awaitTaskDone();
      }
      else {
        await this.performAction({refer_status: this.referStatus});
      }
    } catch (err) {
      this.logger.info({err}, 'TaskSipRefer:exec - error sending REFER');
    }
    this.referSpan?.end();
  }

  async kill(cs) {
    super.kill(cs);
    const {dlg} = cs;
    dlg.off('notify', this.notifyHandler);
    this.notifyTaskDone();
  }

  async _handleNotify(cs, dlg, req, res) {
    res.send(200);

    const contentType = req.get('Content-Type');
    this.logger.debug({body: req.body}, `TaskSipRefer:_handleNotify got ${contentType}`);

    if (contentType === 'message/sipfrag') {
      const arr = /SIP\/2\.0\s+(\d+)/.exec(req.body);
      if (arr) {
        const status = arr[1];
        this.logger.debug(`TaskSipRefer:_handleNotify: call got status ${status}`);
        if (this.eventHook) {
          const b3 = this.getTracingPropagation();
          const httpHeaders = b3 && {b3};
          await cs.requestor.request('verb:hook', this.eventHook,
            {event: 'transfer-status', call_status: status}, httpHeaders);
        }
        if (status >= 200) {
          this.referSpan.setAttributes({'refer.finalNotify': status});
          await this.performAction({refer_status: 202, final_referred_call_status: status});
          this.notifyTaskDone();
        }
      }
    }
  }

  _normalizeReferHeaders(cs, dlg) {
    let {referTo, referredBy} = this;

    /* get IP address of the SBC to use as hostname if needed */
    const {host} = parseUri(dlg.remote.uri);

    if (!referTo.startsWith('<') && !referTo.startsWith('sip') && !referTo.startsWith('"')) {
      /* they may have only provided a phone number/user */
      referTo = `sip:${referTo}@${host}`;
    }
    else this.referToIsUri = true;
    if (!referredBy) {
      /* default */
      referredBy = cs.req?.callingNumber || dlg.local.uri;
      this.logger.info({referredBy}, 'setting referredby');
    }
    if (!referredBy.startsWith('<') && !referredBy.startsWith('sip') && !referredBy.startsWith('"')) {
      /* they may have only provided a phone number/user */
      referredBy = `sip:${referredBy}@${host}`;
    }
    return {referTo, referredBy};
  }
}

module.exports = TaskSipRefer;
