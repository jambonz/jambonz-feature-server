const {CallDirection, CallStatus} = require('../utils/constants');
const uuidv4 = require('uuid/v4');

class CallInfo {
  constructor(opts) {
    this.direction = opts.direction;
    if (this.direction === CallDirection.Inbound) {
      // inbound call
      const {app, req} = opts;
      this.callSid = req.locals.callSid,
      this.accountSid = app.account_sid,
      this.applicationSid = app.application_sid;
      this.from = req.callingNumber;
      this.to = req.calledNumber;
      this.callerName = this.from.name || req.callingNumber;
      this.callId = req.get('Call-ID');
      this.sipStatus = 100;
      this.callStatus = CallStatus.Trying;
      this.originatingSipIP = req.get('X-Forwarded-For');
      this.originatingSipTrunkName = req.get('X-Originating-Carrier');
    }
    else if (opts.parentCallInfo) {
      // outbound call that is a child of an existing call
      const {req, parentCallInfo, to, callSid} = opts;
      this.callSid = callSid || uuidv4();
      this.parentCallSid = parentCallInfo.callSid;
      this.accountSid = parentCallInfo.accountSid;
      this.applicationSid = parentCallInfo.applicationSid;
      this.from = req.callingNumber;
      this.to = to;
      this.callerId = this.from.name || req.callingNumber;
      this.callId = req.get('Call-ID');
      this.callStatus = CallStatus.Trying,
      this.sipStatus = 100;
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
      this.from = req.callingNumber;
      this.to = to;
      if (tag) this._customerData = tag;
    }
  }

  updateCallStatus(callStatus, sipStatus) {
    this.callStatus = callStatus;
    if (sipStatus) this.sipStatus = sipStatus;
  }

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
    ['parentCallSid', 'originatingSipIP', 'originatingSipTrunkName'].forEach((prop) => {
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
