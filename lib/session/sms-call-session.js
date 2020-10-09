const CallSession = require('./call-session');

/**
 * @classdesc Subclass of CallSession.  Represents a CallSession
 * that is established for the purpose of sending an outbound SMS
 * @extends CallSession

 */
class SmsCallSession extends CallSession {
  constructor({logger, application, srf, tasks, callInfo}) {
    super({
      logger,
      application,
      srf,
      tasks,
      callInfo
    });
  }

}

module.exports = SmsCallSession;
