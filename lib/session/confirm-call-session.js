const CallSession = require('./call-session');

/**
 * @classdesc Subclass of CallSession.  Represents a CallSession
 * that is established for a dial verb that has a
 * 'confirmUrl' application that is executed upon call answer.
 * @extends CallSession

 */
class ConfirmCallSession extends CallSession {
  // eslint-disable-next-line max-len
  constructor({logger, application, dlg, ep, tasks, callInfo, accountInfo, memberId, confName, rootSpan, req, tmpFiles}) {
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
    this.req = req;
    this.tmpFiles = tmpFiles;
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
