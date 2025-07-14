const CallSession = require('./call-session');
const {CallStatus} = require('../utils/constants');
const moment = require('moment');
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

    setImmediate(() => {
      this._notifyCallStatusChange({
        callStatus: CallStatus.Trying,
        sipStatus: 100,
        sipReason: 'Trying'
      });
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
    this.logger.info(`RestCallSession: called party hung up by ${terminatedBy}`);
    this._callReleased();
  }

}

module.exports = RestCallSession;
