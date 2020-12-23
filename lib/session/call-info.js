const {CallDirection, CallStatus} = require('../utils/constants');
const parseUri = require('drachtio-srf').parseUri;
const { v4: uuidv4 } = require('uuid');

/**
 * @classdesc Represents the common information for all calls
 * that is provided in call status webhooks
 */
class CallInfo {
  constructor(opts) {
    let from ;
    this.direction = opts.direction;
    if (opts.req) {
      const u = opts.req.getParsedHeader('from');
      const uri = parseUri(u.uri);
      from = uri.user;
      this.callerName = u.name || '';
    }
    if (this.direction === CallDirection.Inbound) {
      // inbound call
      const {app, req} = opts;
      this.callSid = req.locals.callSid,
      this.accountSid = app.account_sid,
      this.applicationSid = app.application_sid;
      this.from = from || req.callingNumber;
      this.to = req.calledNumber;
      this.callId = req.get('Call-ID');
      this.sipStatus = 100;
      this.callStatus = CallStatus.Trying;
      this.originatingSipIp = req.get('X-Forwarded-For');
      this.originatingSipTrunkName = req.get('X-Originating-Carrier');
    }
    else if (opts.parentCallInfo) {
      // outbound call that is a child of an existing call
      const {req, parentCallInfo, to, callSid} = opts;
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
    }
    else if (this.direction === CallDirection.None) {
      // outbound SMS
      const {messageSid, accountSid, applicationSid, res} = opts;
      this.messageSid = messageSid;
      this.accountSid = accountSid;
      this.applicationSid = applicationSid;
      this.res = res;
    }
    else {
      // outbound call triggered by REST
      const {req, accountSid, applicationSid, to, tag} = opts;
      this.callSid = uuidv4();
      this.accountSid = accountSid;
      this.applicationSid = applicationSid;
      this.callStatus = CallStatus.Trying,
      this.callId = req.get('Call-ID');
      this.sipStatus = 100;
      this.from = from || req.callingNumber;
      this.to = to;
      if (tag) this._customerData = tag;
    }
  }

  /**
   * update the status of the call
   * @param {string} callStatus - current call status
   * @param {number} sipStatus - current sip status
   */
  updateCallStatus(callStatus, sipStatus) {
    this.callStatus = callStatus;
    if (sipStatus) this.sipStatus = sipStatus;
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
      callStatus: this.callStatus,
      callerId: this.callerId,
      accountSid: this.accountSid,
      applicationSid: this.applicationSid
    };
    ['parentCallSid', 'originatingSipIp', 'originatingSipTrunkName'].forEach((prop) => {
      if (this[prop]) obj[prop] = this[prop];
    });
    if (typeof this.duration === 'number') obj.duration = this.duration;

    if (this._customerData) {
      Object.assign(obj, {customerData: this._customerData});
    }
    return obj;
  }

}

module.exports = CallInfo;
