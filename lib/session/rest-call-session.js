const CallSession = require('./call-session');
const {CallStatus} = require('../utils/constants');
const moment = require('moment');

/**
 * @classdesc Subclass of CallSession.  This represents a CallSession that is
 * created for an outbound call that is initiated via the REST API.
 * @extends CallSession
 */
class RestCallSession extends CallSession {
  constructor({logger, application, srf, req, ep, tasks, callInfo}) {
    super({
      logger,
      application,
      srf,
      callSid: callInfo.callSid,
      tasks,
      callInfo
    });
    this.req = req;
    this.ep = ep;

    this.on('callStatusChange', this._notifyCallStatusChange.bind(this));
    this._notifyCallStatusChange({callStatus: CallStatus.Trying, sipStatus: 100});
  }

  /**
   * Stores the sip dialog that is created when the far end answers.
   * @param {Dialog} dlg - sip dialog
   */
  setDialog(dlg) {
    this.dlg = dlg;
    dlg.on('destroy', this._callerHungup.bind(this));
    dlg.connectTime = moment();
  }

  /**
   * This is invoked when the called party hangs up, in order to calculate the call duration.
   */
  _callerHungup() {
    const duration = moment().diff(this.dlg.connectTime, 'seconds');
    this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
    this.logger.debug('InboundCallSession: caller hung up');
    this._callReleased();
  }

}

module.exports = RestCallSession;
