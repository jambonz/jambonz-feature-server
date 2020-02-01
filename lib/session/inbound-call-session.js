const CallSession = require('./call-session');
const {CallStatus} = require('../utils/constants');
const moment = require('moment');
const assert = require('assert');

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
    else if (this.dlg.connected) {
      assert(this.dlg.connectTime);
      const duration = moment().diff(this.dlg.connectTime, 'seconds');
      this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
      this.logger.debug('InboundCallSession:_onTasksDone hanging up call since all tasks are done');
    }
  }

  async connectInboundCallToIvr(earlyMedia = false) {

    // check for a stable inbound call already connected to the ivr
    if (this.ep && this.dlg) {
      this.logger.debug('CallSession:connectInboundCallToIvr - inbound call already connected to IVR');
      return {ep: this.ep, dlg: this.dlg};
    }

    // check for an early media connection, where caller wants same
    if (this.ep && earlyMedia) {
      this.logger.debug('CallSession:connectInboundCallToIvr - inbound call already has early media connection');
      return {ep: this.ep};
    }

    // ok, we need to connect the inbound call to the ivr
    try {
      assert(!this.req.finalResponseSent);
      this.logger.debug('CallSession:connectInboundCallToIvr - creating endpoint for inbound call');
      const {ep} = await this.createOrRetrieveEpAndMs();
      this.ep = ep;

      if (earlyMedia) {
        this.res.send(183, {body: ep.local.sdp});
        this.emit('callStatusChange', {sipStatus: 183, callStatus: CallStatus.EarlyMedia});
        return {ep, res: this.res};
      }
      const dlg = await this.srf.createUAS(this.req, this.res, {localSdp: ep.local.sdp});
      dlg.on('destroy', this._callerHungup.bind(this));
      dlg.connectTime = moment();
      this.emit('callStatusChange', {sipStatus: 200, callStatus: CallStatus.InProgress});
      this.logger.debug(`CallSession:connectInboundCallToIvr - answered callSid ${this.callSid}`);
      this.ep = ep;
      this.dlg = dlg;
      return {ep, dlg};
    } catch (err) {
      this.logger.error(err, 'CallSession:connectInboundCallToIvr error');
      throw err;
    }
  }

  async propagateAnswer() {
    if (!this.dlg) {
      assert(this.ep);
      this.dlg = await this.srf.createUAS(this.req, this.res, {localSdp: this.ep.local.sdp});
      this.dlg.connectTime = moment();
      this.dlg.on('destroy', this._callerHungup.bind(this));
      this.emit('callStatusChange', {sipStatus: 200, callStatus: CallStatus.InProgress});
      this.logger.debug(`CallSession:propagateAnswer - answered callSid ${this.callSid}`);
    }
  }

  _callerHungup() {
    assert(this.dlg.connectTime);
    const duration = moment().diff(this.dlg.connectTime, 'seconds');
    this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
    this.logger.debug('InboundCallSession: caller hung up');
    this._callReleased();
  }

}

module.exports = InboundCallSession;
