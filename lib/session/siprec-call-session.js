const InboundCallSession = require('./inbound-call-session');
const {createSipRecPayload} = require('../utils/siprec-utils');
const {CallStatus} = require('../utils/constants');
/**
 * @classdesc Subclass of InboundCallSession.  This represents a CallSession that is
 * established for an inbound SIPREC call.
 * @extends InboundCallSession
 */
class SipRecCallSession extends InboundCallSession {
  constructor(req, res) {
    super(req, res);

    const {sdp1, sdp2, metadata} = req.locals.siprec;
    this.sdp1 = sdp1;
    this.sdp2 = sdp2;
    this.metadata = metadata;
  }

  async answerSipRecCall() {
    try {
      this.ms = this.getMS();
      let remoteSdp = this.sdp1.replace(/sendonly/, 'sendrecv');
      this.ep = await this.ms.createEndpoint({remoteSdp});
      //this.logger.debug({remoteSdp, localSdp: this.ep.local.sdp}, 'SipRecCallSession - allocated first endpoint');
      remoteSdp = this.sdp2.replace(/sendonly/, 'sendrecv');
      this.ep2 = await this.ms.createEndpoint({remoteSdp});
      //this.logger.debug({remoteSdp, localSdp: this.ep2.local.sdp}, 'SipRecCallSession - allocated second endpoint');
      await this.ep.bridge(this.ep2);
      const combinedSdp = await createSipRecPayload(this.ep.local.sdp, this.ep2.local.sdp, this.logger);
      /*
      this.logger.debug({
        combinedSdp
      }, 'SipRecCallSession:_answerSipRecCall - created SIPREC payload');
      */
      this.dlg = await this.srf.createUAS(this.req, this.res, {
        headers: {
          'Content-Type': 'application/sdp',
          'X-Trace-ID': this.req.locals.traceId,
          'X-Call-Sid': this.req.locals.callSid,
          ...(this.applicationSid && {'X-Application-Sid': this.applicationSid})
        },
        localSdp: combinedSdp
      });
      this.dlg.on('destroy', this._callerHungup.bind(this));
      this.wrapDialog(this.dlg);
      this.dlg.callSid = this.callSid;
      this.emit('callStatusChange', {sipStatus: 200, sipReason: 'OK', callStatus: CallStatus.InProgress});

      this.dlg.on('modify', this._onReinvite.bind(this));
      this.dlg.on('refer', this._onRefer.bind(this));
    } catch (err) {
      this.logger.error({err}, 'SipRecCallSession:_answerSipRecCall error:');
      if (this.res && !this.res.finalResponseSent) this.res.send(500);
      this._callReleased();
    }
  }
}

module.exports = SipRecCallSession;
