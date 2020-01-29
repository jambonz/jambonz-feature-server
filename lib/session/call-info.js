const {CallDirection, CallStatus} = require('../utils/constants');
const uuidv4 = require('uuid/v4');

class CallInfo {
  constructor(opts) {
    this.direction = opts.direction;
    if (this.direction === CallDirection.Inbound) {
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
    else if (opts.parentCallInfo instanceof CallInfo) {
      const {req, parentCallInfo} = opts;
      this.callSid = uuidv4();
      this.parentCallSid = parentCallInfo.callSid;
      this.accountSid = parentCallInfo.accountSid;
      this.applicationSid = parentCallInfo.applicationSid;
      this.from = req.callingNumber;
      this.to = req.calledNumber;
      this.callerName = this.from.name || req.callingNumber;
      this.callId = req.get('Call-ID');
      this.callStatus = CallStatus.Trying,
      this.sipStatus = 100;
    }
  }

  updateCallStatus(callStatus, sipStatus) {
    this.callStatus = callStatus;
    if (sipStatus) this.sipStatus = sipStatus;
  }

  set customerData(obj) {
    this._customerData = obj;
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
      callerId: this.callId,
      accountSid: this.accountSid,
      applicationSid: this.applicationSid
    };
    ['parentCallSid', 'originatingSipIP', 'originatingSipTrunkName'].forEach((prop) => {
      if (this[prop]) obj[prop] = this[prop];
    });

    if (this._customerData && Object.keys(this._customerData).length) {
      obj.customerData = this._customerData;
    }
    return obj;
  }
}

module.exports = CallInfo;
