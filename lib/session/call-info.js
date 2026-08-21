const {CallDirection, CallStatus} = require('../utils/constants');
const parseUri = require('drachtio-srf').parseUri;
const crypto = require('crypto');
const {JAMBONES_API_BASE_URL} = require('../config');
/**
 * @classdesc Represents the common information for all calls
 * that is provided in call status webhooks
 */
class CallInfo {
  constructor(opts) {
    let from ;
    let srf;
    this.direction = opts.direction;
    this.traceId = opts.traceId;
    this.hasRecording = false;
    this.callTerminationBy = undefined;
    if (opts.req) {
      const u = opts.req.getParsedHeader('from');
      const uri = parseUri(u.uri);
      from = uri.user;
      this.callerName = u.name || '';
    }
    if (this.direction === CallDirection.Inbound) {
      // inbound call
      const {app, req} = opts;
      srf = req.srf;
      this.callSid = req.locals.callSid,
      this.accountSid = app.account_sid,
      this.applicationSid = app.application_sid;
      this.from = from || req.callingNumber;
      this.to = req.calledNumber;
      this.callId = req.get('Call-ID');
      this.sipStatus = 100;
      this.sipReason = 'Trying';
      this.callStatus = CallStatus.Trying;
      this.sbcCallid = req.get('X-CID');
      this.originatingSipIp = req.get('X-Forwarded-For');
      this.originatingSipTrunkName = req.get('X-Originating-Carrier');
      const {siprec} = req.locals;
      if (siprec) {
        const caller = parseUri(req.locals.callingNumber);
        const callee = parseUri(req.locals.calledNumber);
        this.participants = [
          {
            participant: 'caller',
            uriUser: caller?.user,
            uriHost: caller?.host
          },
          {
            participant: 'callee',
            uriUser: callee?.user,
            uriHost: callee?.host
          }
        ];
      }
    }
    else if (opts.parentCallInfo) {
      // outbound call that is a child of an existing call
      const {req, parentCallInfo, to, callSid} = opts;
      srf = req.srf;
      this.callSid = callSid || crypto.randomUUID();
      this.parentCallSid = parentCallInfo.callSid;
      this.accountSid = parentCallInfo.accountSid;
      this.applicationSid = parentCallInfo.applicationSid;
      this.from = from || req.callingNumber;
      this.to = to;
      this.callerId = this.from.name || req.callingNumber;
      this.callId = req.get('Call-ID');
      this.callStatus = CallStatus.Trying,
      this.sipStatus = 100;
      this.sipReason = 'Trying';
    }
    else if (this.direction === CallDirection.None) {
      // outbound SMS
      const {messageSid, accountSid, applicationSid, res} = opts;
      srf = res.srf;
      this.messageSid = messageSid;
      this.accountSid = accountSid;
      this.applicationSid = applicationSid;
      this.res = res;
    }
    else {
      // outbound call triggered by REST
      const {req, callSid, accountSid, applicationSid, to, tag} = opts;
      srf = req.srf;
      this.callSid = callSid;
      this.accountSid = accountSid;
      this.applicationSid = applicationSid;
      this.callStatus = CallStatus.Trying,
      this.callId = req.get('Call-ID');
      this.sipStatus = 100;
      this.sipReason = 'Trying';
      this.from = from || req.callingNumber;
      this.to = to;
      if (tag) this._customerData = tag;
    }

    this.localSipAddress = srf.locals.localSipAddress;
    if (srf.locals.publicIp) {
      this.publicIp = srf.locals.publicIp;
    }
  }

  /**
   * update the status of the call
   * @param {string} callStatus - current call status
   * @param {number} sipStatus - current sip status
   * @param {string} [sipReason] - reason phrase from the SIP status line
   * @param {string} [sipReasonHeader] - RFC 3326 Reason header of the SIP message that caused
   * this status change, if it carried one.  Unlike the fields above this is assigned
   * unconditionally, so that it always describes the current change rather than lingering
   * from an earlier one.
   *
   * Absence is stored as '' rather than undefined on purpose: the redis call record is
   * written with hmset, which MERGES, and realtimedb-helpers filters undefined out - so an
   * absent key keeps whatever an earlier status change wrote and GET /Calls/:sid reports a
   * cause from the wrong event.  An empty string overwrites it.  This is enough for callers
   * that write the instance itself (SingleDialer); callers writing toJSON() must use
   * toRedisJSON() instead, since toJSON() drops falsy values on purpose to keep the key out
   * of the webhook payload.
   */
  updateCallStatus(callStatus, sipStatus, sipReason, sipReasonHeader) {
    this.callStatus = callStatus;
    if (sipStatus) this.sipStatus = sipStatus;
    if (sipReason) this.sipReason = sipReason;
    this.sipReasonHeader = sipReasonHeader || '';
  }

  /**
   * associate customer-provided data with the call information.
   * this information will be provided with every call status callhook
   */
  set customerData(obj) {
    this._customerData = obj;
  }

  get customerData() {
    return this._customerData;
  }

  set sipHeaders(obj) {
    this._sipHeaders = obj;
  }

  get sipHeaders() {
    return this._sipHeaders;
  }

  /**
   * The redis call record view.  Differs from toJSON() only in fields that must be
   * *cleared*: hmset merges, so a key we omit keeps its previous value, whereas toJSON()
   * deliberately omits falsy values so absent data adds no key to the webhook payload.
   * Any future clearable field belongs here too.
   */
  toRedisJSON() {
    return Object.assign({}, this.toJSON(), {sipReasonHeader: this.sipReasonHeader || ''});
  }

  toJSON() {
    const obj = {
      callSid: this.callSid,
      direction: this.direction,
      from: this.from,
      to: this.to,
      callId: this.callId,
      sbcCallid: this.sbcCallid,
      sipStatus: this.sipStatus,
      sipReason: this.sipReason,
      callStatus: this.callStatus,
      callerId: this.callerId,
      accountSid: this.accountSid,
      traceId: this.traceId,
      applicationSid: this.applicationSid,
      fsSipAddress: this.localSipAddress
    };
    ['parentCallSid', 'originatingSipIp', 'originatingSipTrunkName', 'callTerminationBy',
      'sipReasonHeader'].forEach((prop) => {
      if (this[prop]) obj[prop] = this[prop];
    });
    if (typeof this.duration === 'number') obj.duration = this.duration;

    if (this._customerData) {
      Object.assign(obj, {customerData: this._customerData});
    }

    if (this._sipHeaders) {
      Object.assign(obj, {headers: this._sipHeaders});
    }

    if (JAMBONES_API_BASE_URL) {
      Object.assign(obj, {apiBaseUrl: JAMBONES_API_BASE_URL});
    }
    if (this.publicIp) {
      Object.assign(obj, {fsPublicIp: this.publicIp});
    }
    return obj;
  }

}

module.exports = CallInfo;
