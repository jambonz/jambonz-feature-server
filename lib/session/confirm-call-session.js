const CallSession = require('./call-session');
const {CallDirection} = require('../utils/constants');

class ConfirmCallSession extends CallSession {
  constructor({logger, application, dlg, ep, tasks}) {
    super({
      logger,
      application,
      srf: dlg.srf,
      callSid: dlg.callSid,
      tasks
    });
    this.dlg = dlg;
    this.ep = ep;
    this.direction = CallDirection.Outbound;
  }

  /**
   * empty implementation to override superclass so we do not delete dlg and ep
   */
  _clearCalls() {
  }

}

module.exports = ConfirmCallSession;
