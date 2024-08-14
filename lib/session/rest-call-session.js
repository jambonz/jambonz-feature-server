const CallSession = require('./call-session');
const {CallStatus} = require('../utils/constants');
const moment = require('moment');
const {parseUri} = require('drachtio-srf');
const { normalizeJambones } = require('@jambonz/verb-specifications');
const makeTask = require('../tasks/make_task');

/**
 * @classdesc Subclass of CallSession.  This represents a CallSession that is
 * created for an outbound call that is initiated via the REST API.
 * @extends CallSession
 */
class RestCallSession extends CallSession {
  constructor({logger, application, srf, req, ep, ep2, tasks, callInfo, accountInfo, rootSpan}) {
    super({
      logger,
      application,
      srf,
      callSid: callInfo.callSid,
      tasks,
      callInfo,
      accountInfo,
      rootSpan
    });
    this.req = req;
    this.ep = ep;
    this.ep2 = ep2;
    // keep restDialTask reference for closing AMD
    if (tasks.length) {
      this.restDialTask = tasks[0];
    }

    this.on('callStatusChange', this._notifyCallStatusChange.bind(this));
    this._notifyCallStatusChange({
      callStatus: CallStatus.Trying,
      sipStatus: 100,
      sipReason: 'Trying'
    });
  }

  /**
   * Stores the sip dialog that is created when the far end answers.
   * @param {Dialog} dlg - sip dialog
   */
  setDialog(dlg) {
    this.dlg = dlg;
    dlg.on('destroy', this._callerHungup.bind(this));
    dlg.on('refer', this._onRefer.bind(this));
    dlg.on('modify', this._onReinvite.bind(this));
    this.wrapDialog(dlg);
  }

  /**
   * global referHook
   */

  set referHook(hook) {
    this._referHook = hook;
  }

  /**
   * This is invoked when the called party sends REFER to Jambonz.
   */
  async _onRefer(req, res) {
    if (this._referHook) {
      try {
        const to = parseUri(req.getParsedHeader('Refer-To').uri);
        const by = parseUri(req.getParsedHeader('Referred-By').uri);
        const b3 = this.b3;
        const httpHeaders = b3 && {b3};
        const json = await this.requestor.request('verb:hook', this._referHook, {
          ...(this.callInfo.toJSON()),
          refer_details: {
            sip_refer_to: req.get('Refer-To'),
            sip_referred_by: req.get('Referred-By'),
            sip_user_agent: req.get('User-Agent'),
            refer_to_user: to.scheme === 'tel' ? to.number : to.user,
            referred_by_user: by.scheme === 'tel' ? by.number : by.user,
            referring_call_sid: this.callSid,
            referred_call_sid: null,
          }
        }, httpHeaders);

        if (json && Array.isArray(json)) {
          const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
          if (tasks && tasks.length > 0) {
            this.logger.info('RestCallSession:handleRefer received REFER, get new tasks');
            this.replaceApplication(tasks);
            if (this.wakeupResolver) {
              this.wakeupResolver({reason: 'RestCallSession: referHook new taks'});
              this.wakeupResolver = null;
            }
          }
        }
        res.send(202);
        this.logger.info('RestCallSession:handleRefer - sent 202 Accepted');
      } catch (err) {
        this.logger.error({err}, 'RestCallSession:handleRefer - error while asking referHook');
        res.send(err.statusCode || 501);
      }
    } else {
      res.send(501);
    }
  }
  /**
   * This is invoked when the called party hangs up, in order to calculate the call duration.
   */
  _callerHungup() {
    this._hangup('caller');
  }

  _jambonzHangup() {
    this._hangup();
  }

  _hangup(terminatedBy = 'jambonz') {
    if (this.restDialTask) {
      this.restDialTask.turnOffAmd();
    }
    this.callInfo.callTerminationBy = terminatedBy;
    const duration = moment().diff(this.dlg.connectTime, 'seconds');
    this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
    this.logger.debug(`RestCallSession: called party hung up by ${terminatedBy}`);
    this._callReleased();
  }

}

module.exports = RestCallSession;
