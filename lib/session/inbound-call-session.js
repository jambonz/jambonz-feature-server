const CallSession = require('./call-session');
const {CallStatus} = require('../utils/constants');
const moment = require('moment');
const assert = require('assert');

/**
 * @classdesc Subclass of CallSession.  This represents a CallSession that is
 * established for an inbound call.
 * @extends CallSession
 */
class InboundCallSession extends CallSession {
  constructor(req, res) {
    super({
      logger: req.locals.logger,
      srf: req.srf,
      application: req.locals.application,
      callInfo: req.locals.callInfo,
      accountInfo: req.locals.accountInfo,
      tasks: req.locals.application.tasks,
      rootSpan: req.locals.rootSpan
    });
    this.req = req;
    this.res = res;

    req.once('cancel', this._onCancel.bind(this));

    this.on('callStatusChange', this._notifyCallStatusChange.bind(this));
    this._notifyCallStatusChange({
      callStatus: CallStatus.Trying,
      sipStatus: 100,
      sipReason: 'Trying'
    });
  }

  _onCancel() {
    this.rootSpan.setAttributes({'call.termination': 'caller abandoned'});
    this.callInfo.callTerminationBy = 'caller';
    this._notifyCallStatusChange({
      callStatus: CallStatus.NoAnswer,
      sipStatus: 487,
      sipReason: 'Request Terminated'
    });
    this._callReleased();
  }

  _onTasksDone() {
    if (!this.res.finalResponseSent) {
      if (this._mediaServerFailure) {
        this.rootSpan.setAttributes({'call.termination': 'media server failure'});
        this.logger.info('InboundCallSession:_onTasksDone generating 480 due to media server failure');
        this.res.send(480, {
          headers: {
            'X-Reason': 'crankback: media server failure'
          }
        });
      }
      else {
        this.rootSpan.setAttributes({'call.termination': 'tasks completed without answering call'});
        this.logger.info('InboundCallSession:_onTasksDone auto-generating non-success response to invite');
        this.res.send(603);
      }
    }
    this.req.removeAllListeners('cancel');
  }

  /**
   * This is invoked when the caller hangs up, in order to calculate the call duration.
   */
  _callerHungup() {
    assert(this.dlg.connectTime);
    const duration = moment().diff(this.dlg.connectTime, 'seconds');
    this.rootSpan.setAttributes({'call.termination': 'hangup by caller'});
    this.callInfo.callTerminationBy = 'caller';
    this.emit('callStatusChange', {
      callStatus: CallStatus.Completed,
      duration
    });
    this.logger.info('InboundCallSession: caller hung up');
    this._callReleased();
    this.req.removeAllListeners('cancel');
  }
}

module.exports = InboundCallSession;
