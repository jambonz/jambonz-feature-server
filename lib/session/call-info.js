const {CallDirection, CallStatus} = require('../utils/constants');
const parseUri = require('drachtio-srf').parseUri;
const uuidv4 = require('uuid-random');
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
      this.originatingSipIp = req.get('X-Forwarded-For');
      this.originatingSipTrunkName = req.get('X-Originating-Carrier');
    }
    else if (opts.parentCallInfo) {
      // outbound call that is a child of an existing call
      const {req, parentCallInfo, to, callSid} = opts;
      srf = req.srf;
      this.callSid = callSid || uuidv4();
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
   */
  updateCallStatus(callStatus, sipStatus, sipReason) {
    this.callStatus = callStatus;
    if (sipStatus) this.sipStatus = sipStatus;
    if (sipReason) this.sipReason = sipReason;
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

  toJSON() {
    const obj = {
      callSid: this.callSid,
      direction: this.direction,
      from: this.from,
      to: this.to,
      callId: this.callId,
      sipStatus: this.sipStatus,
      sipReason: this.sipReason,
      callStatus: this.callStatus,
      callerId: this.callerId,
      accountSid: this.accountSid,
      traceId: this.traceId,
      applicationSid: this.applicationSid,
      fsSipAddress: this.localSipAddress
    };
    ['parentCallSid', 'originatingSipIp', 'originatingSipTrunkName', 'callTerminationBy'].forEach((prop) => {
      if (this[prop]) obj[prop] = this[prop];
    });
    if (typeof this.duration === 'number') obj.duration = this.duration;

    if (this._customerData) {
      Object.assign(obj, {customerData: this._customerData});
    }

    if (process.env.JAMBONES_API_BASE_URL) {
      Object.assign(obj, {apiBaseUrl: process.env.JAMBONES_API_BASE_URL});
    }
    if (this.publicIp) {
      Object.assign(obj, {fsPublicIp: this.publicIp});
    }
    return obj;
  }

}

module.exports = CallInfo;
