const Task = require('./task');
const {TaskName, TaskPreconditions, KillReason} = require('../utils/constants');
const {parseUri} = require('drachtio-srf');

/* how long we wait for a NOTIFY carrying the final status of the referred call */
const NOTIFY_TIMEOUT_MS = 15000;

/* SIP status returned by a far end that accepted the REFER */
const REFER_ACCEPTED = 202;

/**
 * sends a sip REFER to transfer the existing call
 */
class TaskSipRefer extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.StableCall;

    this.referTo = this.data.referTo;
    this.referredBy = this.data.referredBy;
    this.referredByDisplayName = this.data.referredByDisplayName;
    this.headers = this.data.headers || {};
    this.eventHook = this.data.eventHook;
    this._actionPromise = null;
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
      if (this.referStatus === REFER_ACCEPTED) {
        this._notifyTimer = setTimeout(() => {
          this.logger.info(`TaskSipRefer:exec - no NOTIFY received in ${NOTIFY_TIMEOUT_MS} ms, exiting`);
          this.notifyTaskDone();
        }, NOTIFY_TIMEOUT_MS);
        await this.awaitTaskDone();
        if (this._notifyTimer) {
          clearTimeout(this._notifyTimer);
          this._notifyTimer = null;
        }
      }
      /* the far end may send BYE before any NOTIFY arrives, which kills this task while we are
         awaiting above; performing the action here means the actionHook runs on every exit path -
         and while the requestor is still up - rather than only when the NOTIFY timer expires */
      await this._performReferAction({refer_status: this.referStatus});
    } catch (err) {
      this.logger.info({err}, 'TaskSipRefer:exec - error sending REFER');
    }
    this.referSpan?.end();
  }

  async kill(cs, reason) {
    super.kill(cs);
    this.killReason = reason || KillReason.Hangup;
    const {dlg} = cs;
    dlg.off('notify', this.notifyHandler);
    this.notifyTaskDone();
  }

  async _handleNotify(cs, dlg, req, res) {
    res.send(200);

    const contentType = req.get('Content-Type');
    this.logger.debug({body: req.body}, `TaskSipRefer:_handleNotify got ${contentType}`);

    if (contentType?.includes('message/sipfrag')) {
      const arr = /SIP\/2\.0\s+(\d+)/.exec(req.body);
      if (arr) {
        const status = typeof arr[1] === 'string' ? parseInt(arr[1], 10) : arr[1];
        this.logger.debug(`TaskSipRefer:_handleNotify: call got status ${status}`);
        if (this.eventHook) {
          const b3 = this.getTracingPropagation();
          const httpHeaders = b3 && {b3};
          await cs.requestor.request('verb:hook', this.eventHook,
            {event: 'transfer-status', call_status: status}, httpHeaders);
        }
        if (status >= 200) {
          this.referSpan.setAttributes({'refer.finalNotify': status});
          await this._performReferAction({refer_status: REFER_ACCEPTED, final_referred_call_status: status});
          this.notifyTaskDone();
        }
      }
    }
  }

  /**
   * fire the verb's actionHook exactly once, whichever exit path completes the task:
   * a final NOTIFY, the NOTIFY timeout, or the task being killed by an early BYE
   */
  _performReferAction(results) {
    if (!this._actionPromise) {
      /* when the app replaced this verb with new commands, still notify it, but do not let the
         hook response replace the application a second time (same contract as the dial verb) */
      this._actionPromise = this.performAction(results, this.killReason !== KillReason.Replaced)
        .catch((err) => this.logger.error({err}, 'TaskSipRefer:_performReferAction - error performing action'));
    }
    /* callers await the shared promise, so exec() cannot return - and let the session close the
       requestor - while an actionHook started by another exit path is still in flight */
    return this._actionPromise;
  }

  _normalizeReferHeaders(cs, dlg) {
    let {referTo, referredBy, referredByDisplayName} = this;

    /* get IP address of the SBC to use as hostname if needed */
    const {host} = parseUri(dlg.remote.uri);

    if (
      !referTo.startsWith('<') &&
      !referTo.startsWith('sip:') &&
      !referTo.startsWith('"') &&
      !referTo.startsWith('tel:')
    ) {
      /* they may have only provided a phone number/user */
      referTo = `sip:${referTo}@${host}`;
    }
    else this.referToIsUri = true;
    if (!referredBy) {
      /* default */
      referredBy = cs.req?.callingNumber || dlg.local.uri;
      this.logger.info({referredBy}, 'setting referredby');
    }
    if (!referredByDisplayName) {
      referredByDisplayName = cs.req?.callingName;
    }
    if (
      !referredBy.startsWith('<') &&
      !referredBy.startsWith('sip:') &&
      !referredBy.startsWith('"') &&
      !referredBy.startsWith('tel:')
    ) {
      /* they may have only provided a phone number/user */
      referredBy = `${referredByDisplayName ? `"${referredByDisplayName}"` : ''}<sip:${referredBy}@${host}>`;
    }
    return {referTo, referredBy};
  }
}

module.exports = TaskSipRefer;
