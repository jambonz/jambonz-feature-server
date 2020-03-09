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
      tasks: req.locals.application.tasks
    });
    this.req = req;
    this.res = res;

    req.on('cancel', this._callReleased.bind(this));

    this.on('callStatusChange', this._notifyCallStatusChange.bind(this));
    this._notifyCallStatusChange({callStatus: CallStatus.Trying, sipStatus: 100});
  }

  _onTasksDone() {
    if (!this.res.finalResponseSent) {
      this.logger.info('InboundCallSession:_onTasksDone auto-generating non-success response to invite');
      this.res.send(603);
    }
  }

  /**
   * Answer the call, if it has not already been answered.
   */
  async propagateAnswer() {
    if (!this.dlg) {
      assert(this.ep);
      this.dlg = await this.srf.createUAS(this.req, this.res, {localSdp: this.ep.local.sdp});
      this.wrapDialog(this.dlg);
      this.dlg.on('destroy', this._callerHungup.bind(this));
      this.emit('callStatusChange', {sipStatus: 200, callStatus: CallStatus.InProgress});
      this.logger.debug(`CallSession:propagateAnswer - answered callSid ${this.callSid}`);
    }
  }

  /**
   * This is invoked when the caller hangs up, in order to calculate the call duration.
   */
  _callerHungup() {
    assert(this.dlg.connectTime);
    const duration = moment().diff(this.dlg.connectTime, 'seconds');
    this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
    this.logger.debug('InboundCallSession: caller hung up');
    this._callReleased();
  }
}

module.exports = InboundCallSession;
