const CallSession = require('./call-session');

/**
 * @classdesc Subclass of CallSession.  Represents a CallSession
 * that is established for a dial verb that has a
 * 'confirmUrl' application that is executed upon call answer.
 * @extends CallSession

 */
class ConfirmCallSession extends CallSession {
  constructor({logger, application, dlg, ep, tasks, callInfo, accountInfo, memberId, confName, rootSpan}) {
    super({
      logger,
      application,
      srf: dlg.srf,
      callSid: dlg.callSid,
      tasks,
      callInfo,
      accountInfo,
      memberId,
      confName,
      rootSpan
    });
    this.dlg = dlg;
    this.ep = ep;
  }

  /**
   * empty implementation to override superclass so we do not delete dlg and ep
   */
  _clearResources() {
  }

  _callerHungup() {
  }

  _jambonzHangup() {
  }


}

module.exports = ConfirmCallSession;
