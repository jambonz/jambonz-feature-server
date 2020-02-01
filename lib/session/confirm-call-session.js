const CallSession = require('./call-session');

class ConfirmCallSession extends CallSession {
  constructor({logger, application, dlg, ep, tasks, callInfo}) {
    super({
      logger,
      application,
      srf: dlg.srf,
      callSid: dlg.callSid,
      tasks,
      callInfo
    });
    this.dlg = dlg;
    this.ep = ep;
  }

  /**
   * empty implementation to override superclass so we do not delete dlg and ep
   */
  _clearCalls() {
  }

}

module.exports = ConfirmCallSession;
