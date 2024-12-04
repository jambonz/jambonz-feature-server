const CallSession = require('./call-session');
const {CallStatus} = require('../utils/constants');
const moment = require('moment');

/**
 * @classdesc Subclass of CallSession.  Represents a CallSession
 * that was initially a child call leg; i.e. established via a Dial verb.
 * Now it is all grown up and filling out its own CallSession.  Yoo-hoo!
 * @extends CallSession

 */
class AdultingCallSession extends CallSession {
  constructor({logger, application, singleDialer, tasks, callInfo, accountInfo, rootSpan}) {
    super({
      logger,
      application,
      srf: singleDialer.dlg.srf,
      tasks,
      callInfo,
      accountInfo,
      rootSpan
    });
    this.sd = singleDialer;
    this.req = callInfo.req;

    this.sd.dlg.on('destroy', () => {
      this.logger.info('AdultingCallSession: called party hung up');
      this._callReleased();
    });
    this.sd.emit('adulting');
    this.on('callStatusChange', this._notifyCallStatusChange.bind(this));
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

  // When adulting session kicked from conference, replaceEndpoint is a must
  set ep(newEp) {
    this.sd.ep = newEp;
  }

  get callSid() {
    return this.callInfo.callSid;
  }

  _callerHungup() {
    this._hangup('caller');
  }

  _jambonzHangup() {
    this._hangup();
  }

  _hangup(terminatedBy = 'jambonz') {
    if (this.dlg.connectTime) {
      const duration = moment().diff(this.dlg.connectTime, 'seconds');
      this.rootSpan.setAttributes({'call.termination': `hangup by ${terminatedBy}`});
      this.callInfo.callTerminationBy = terminatedBy;
      this.emit('callStatusChange', {
        callStatus: CallStatus.Completed,
        duration
      });
    }
    this.logger.info(`InboundCallSession: ${terminatedBy} hung up`);
    this._callReleased();
    this.req.removeAllListeners('cancel');
  }
}

module.exports = AdultingCallSession;
