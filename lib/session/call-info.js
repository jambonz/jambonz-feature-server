class CallInfo {
  constructor(opts) {
    this.callSid = opts.callSid;
    this.parentCallSid = opts.parentCallSid;
    this.direction = opts.direction;
    this.from = opts.from;
    this.to = opts.to;
    this.callId = opts.callId;
    this.sipStatus = opts.sipStatus;
    this.callStatus = opts.callStatus;
    this.callerId = opts.callerId;
    this.accountSid = opts.accountSid;
    this.applicationSid = opts.applicationSid;
  }

  updateCallStatus(callStatus, sipStatus) {
    this.callStatus = callStatus;
    if (sipStatus) this.sipStatus = sipStatus;
  }
}

module.exports = CallInfo;
