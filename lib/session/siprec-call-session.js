const InboundCallSession = require('./inbound-call-session');
const {createSipRecPayload} = require('../utils/siprec-utils');
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

    setImmediate(this._answerSipRecCall.bind(this));
  }

  async _answerSipRecCall() {
    try {
      this.ms = this.getMS();
      this.ep = await this.ms.createEndpoint({remoteSdp: this.sdp1});
      this.ep2 = await this.ms.createEndpoint({remoteSdp: this.sdp2});
      await this.ep.bridge(this.ep2);
      const combinedSdp = await createSipRecPayload(this.ep.local.sdp, this.ep2.local.sdp, this.logger);
      this.logger.debug({
        sdp1: this.sdp1,
        sdp2: this.sdp2,
        combinedSdp
      }, 'SipRecCallSession:_answerSipRecCall - created SIPREC payload');
      this.dlg = await this.srf.createUAS(this.req, this.res, {
        headers: {
          'X-Trace-ID': this.req.locals.traceId,
          'X-Call-Sid': this.req.locals.callSid
        },
        localSdp: combinedSdp
      });
    } catch (err) {
      this.logger.error({err}, 'SipRecCallSession:_answerSipRecCall error:');
      if (this.res && !this.res.finalResponseSent) this.res.send(500);
      this._callReleased();
    }
  }

  _callReleased() {
    /* release that second endpoint we created, then call superclass implementation */
    if (this.ep2?.connected) {
      this.ep2.destroy();
      this.ep2 = null;
    }
    super._callReleased();
  }
}

module.exports = SipRecCallSession;
