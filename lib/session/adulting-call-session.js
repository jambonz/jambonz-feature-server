const CallSession = require('./call-session');

/**
 * @classdesc Subclass of CallSession.  Represents a CallSession
 * that was initially a child call leg; i.e. established via a Dial verb.
 * Now it is all grown up and filling out its own CallSession.  Yoo-hoo!
 * @extends CallSession

 */
class AdultingCallSession extends CallSession {
  constructor({logger, application, singleDialer, tasks, callInfo, accountInfo}) {
    super({
      logger,
      application,
      srf: singleDialer.dlg.srf,
      tasks,
      callInfo,
      accountInfo
    });
    this.sd = singleDialer;

    this.sd.dlg.on('destroy', () => {
      this.logger.info('AdultingCallSession: called party hung up');
      this._callReleased();
    });
    this.sd.emit('adulting');
  }

  get dlg() {
    return this.sd.dlg;
  }

  /**
   * Note: this is not an error.  It is only here to avoid an assert ("no setter for dlg")
   * when there is a call in Session:_clearResources to null out dlg and ep
   */
  set dlg(newDlg) {}

  get ep() {
    return this.sd.ep;
  }

  /* see note above */
  set ep(newEp) {}

  get callSid() {
    return this.callInfo.callSid;
  }


}

module.exports = AdultingCallSession;
