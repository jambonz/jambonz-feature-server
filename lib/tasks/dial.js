const Task = require('./task');
const makeTask = require('./make_task');
const {CallStatus, CallDirection, TaskName, TaskPreconditions} = require('../utils/constants');
const SipError = require('drachtio-srf').SipError;
const assert = require('assert');
const uuidv4 = require('uuid/v4');
const request = require('request');
const moment = require('moment');

function isFinalCallStatus(status) {
  return [CallStatus.Completed, CallStatus.NoAnswer, CallStatus.Failed, CallStatus.Busy].includes(status);
}
class TaskDial extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.None;

    this.action = opts.action;
    this.earlyMedia = opts.answerOnBridge === true;
    this.callerId = opts.callerId;
    this.dialMusic = opts.dialMusic;
    this.headers = this.data.headers || {};
    this.method = opts.method || 'POST';
    this.statusCallback = opts.statusCallback;
    this.statusCallbackMethod = opts.statusCallbackMethod || 'POST';
    this.target = opts.target;
    this.timeout = opts.timeout || 60;
    this.timeLimit = opts.timeLimit;

    if (opts.listen) {
      this.listenTask = makeTask(logger, {'listen': opts.listen});
    }
    if (opts.transcribe) {
      this.transcribeTask = makeTask(logger, {'transcribe' : opts.transcribe});
    }

    this.canceled = false;
    this.callAttributes = {};
    this.dialCallStatus = CallStatus.Failed;
    this.dialCallSid = null;
    this.dialCallDuration = null;

    this.on('callStatusChange', this._onCallStatusChange.bind(this));
  }

  get name() { return TaskName.Dial; }

  async exec(cs) {
    try {
      this._initializeCallData(cs);
      await this._initializeInbound(cs);
      await this._attemptCalls(cs);
      await this._waitForCompletion(cs);
    } catch (err) {
      this.logger.error(`TaskDial:exec terminating with error ${err.message}`);
    }
    await this._actionHook(cs);
    this.clearResources();

    return true;
  }

  _initializeCallData(cs) {
    this.logger.debug(`TaskDial:_initializeCallData parent call sid is ${cs.callSid}`);
    Object.assign(this.callAttributes, {
      AccountSid: cs.AccountSid,
      ParentCallSid: cs.callSid,
      Direction: CallDirection.Outbound
    });
  }

  async _initializeInbound(cs) {
    const {req} = cs;

    // the caller could hangup in the middle of all this..
    req.on('cancel', this._onCancel.bind(this, cs));

    try {
      const result = await cs.connectInboundCallToIvr(this.earlyMedia);
      if (!result) throw new Error('outbound dial via API not supported yet');

      const {ep, dlg, res} = result;
      assert(ep);
      // play dial music to caller, if provided
      if (this.dialMusic) {
        ep.play(this.dialMusic, (err) => {
          if (err) this.logger.error(err, `TaskDial:_initializeInbound - error playing ${this.dialMusic}`);
        });
      }
      this.epIn = ep;
      this.dlgIn = dlg;
      this.res = res;
    } catch (err) {
      this.logger.error(err, 'TaskDial:_initializeInbound error');
      throw err;
    }
  }

  async _attemptCalls(cs) {
    const {req, srf} = cs;

    // send all outbound calls back to originating SBC for simplicity
    const sbcAddress = `${req.source_address}:${req.source_port}`;

    const callSid = uuidv4();
    let newCallId, to, from;
    try {
      // create an endpoint for the outbound call
      const epOut = await cs.createEndpoint();
      this.addResource('epOut', epOut);

      const {uri, opts} = this._prepareOutdialAttempt(this.target[0], sbcAddress,
        this.callerId || req.callingNumber, epOut.local.sdp);

      let streamConnected = false;

      const connectStreams = async(remoteSdp) => {
        streamConnected = true;
        epOut.modify(remoteSdp);
        this.epIn.bridge(epOut);
        if (!this.dlgIn) {
          this.dlgIn = await cs.srf.answerParentCall(this.epIn.local.sdp);
        }
      };

      // outdial requested destination
      const uac = await srf.createUAC(uri, opts, {
        cbRequest: (err, reqSent) => {
          this.outboundInviteInProgress = reqSent;
          newCallId = req.get('Call-ID');
          from = reqSent.callingNumber,
          to = reqSent.calledNumber;
          this.emit('callStatusChange', {
            CallSid: callSid,
            SipCallId: newCallId,
            CallStatus: CallStatus.Trying,
            From: from,
            To: to,
            SipStatus: 100
          });
        },
        cbProvisional: (prov) => {
          if ([180, 183].includes(prov.status)) {
            this.emit('callStatusChange', {
              CallSid: callSid,
              SipCallId: newCallId,
              CallStatus: prov.body ? CallStatus.EarlyMedia : CallStatus.Ringing,
              From: from,
              To: to,
              SipStatus: prov.status
            });
            if (!streamConnected && prov.body) connectStreams(prov.body);
          }
        }
      });

      // outbound call was established
      uac.connectTime = moment();
      uac.callSid = this.dialCallSid = callSid;
      uac.from = from;
      uac.to = to;
      this.emit('callStatusChange', {
        CallSid: callSid,
        SipCallId: newCallId,
        From: from,
        To: to,
        CallStatus: CallStatus.InProgress,
        SipStatus: 200
      });
      uac.on('destroy', () => {
        const duration = this.dialCallDuration = moment().diff(uac.connectTime, 'seconds');
        this.emit('callStatusChange', {
          CallSid: callSid,
          SipCallId: newCallId,
          From: from,
          To: to,
          CallStatus: CallStatus.Completed,
          Duration: duration
        });
      });
      if (!streamConnected) connectStreams(uac.remote.sdp);
      this.outboundInviteInProgress = null;
      this.addResource('dlgOut', uac);
    } catch (err) {
      if (err instanceof SipError) {
        switch (err.status) {
          case 487:
            this.emit('callStatusChange', {
              CallSid: callSid,
              SipCallId: newCallId,
              From: from,
              To: to,
              CallStatus: CallStatus.NoAnswer,
              SipStatus: err.status
            });
            break;
          case 486:
          case 600:
            this.emit('callStatusChange', {
              CallSid: callSid,
              SipCallId: newCallId,
              From: from,
              To: to,
              CallStatus: CallStatus.Busy,
              SipStatus: err.status
            });
            break;
          default:
            this.emit('callStatusChange', {callSid,
              CallSid: callSid,
              SipCallId: newCallId,
              From: from,
              To: to,
              CallStatus: CallStatus.Failed,
              SipStatus: err.status
            });
            break;
        }
        if (err.status !== 487) {
          this.logger.info(`TaskDial:_connectCall outdial failed with ${err.status}`);
        }
      }
      else {
        this.emit('callStatusChange', {
          CallSid: callSid,
          SipCallId: newCallId,
          From: from,
          To: to,
          CallStatus: CallStatus.Failed,
          SipStatus: 500
        });
        this.logger.error(err, 'TaskDial:_connectCall error');
      }
      throw err;
    }
  }

  _prepareOutdialAttempt(target, sbcAddress, callerId, sdp) {
    const opts = {
      headers: this.headers,
      proxy: `sip:${sbcAddress}`,
      callingNumber: callerId,
      localSdp: sdp
    };
    let uri;

    switch (target.type) {
      case 'phone':
        uri = `sip:${target.number}@${sbcAddress}`;
        break;
      case 'sip':
        uri = target.uri;
        if (target.auth) Object.assign(opts, {auth: target.auth});
        break;
      case 'user':
        uri = `sip:${target.name}`;
        break;
      default:
        assert(0, `TaskDial:_prepareOutdialAttempt invalid target type ${target.type}; please fix specs.json`);
    }
    return {uri, opts};
  }

  _onCancel(cs) {
    this.logger.info('TaskDial: caller hung up before connecting');
    this.canceled = true;
    cs.emit('callStatusChange', {status: CallStatus.NoAnswer});
  }

  _onCallerHangup(cs, dlg) {
    this.logger.info('TaskDial: caller hung up');
    cs.emit('callStatusChange', {status: CallStatus.Completed});
    if (this.outboundInviteInProgress) this.outboundInviteInProgress.cancel();

    // we are going to hang up the B leg shortly..so
    const dlgOut = this.getResource('dlgOut');
    if (dlgOut) {
      const duration = this.dialCallDuration = moment().diff(dlgOut.connectTime, 'seconds');
      this.emit('callStatusChange', {
        CallSid: dlgOut.callSid,
        SipCallId: dlgOut.sip.callId,
        From: dlgOut.from,
        To: dlgOut.to,
        CallStatus: CallStatus.Completed,
        Duration: duration
      });
    }
  }


  /**
   * returns a Promise that resolves when either party hangs up
   */
  _waitForCompletion(cs) {

    return new Promise((resolve) => {
      const dlgOut = this.getResource('dlgOut');
      assert(this.dlgIn && dlgOut);
      assert(this.dlgIn.connected && dlgOut.connected);

      [this.dlgIn, dlgOut].forEach((dlg) => dlg.on('destroy', () => resolve()));
    });
  }

  _onCallStatusChange(evt) {
    this.logger.debug(evt, 'TaskDial:_onCallStatusChange');

    // save the most recent final call status of a B leg, until we get one that is completed
    if (isFinalCallStatus(evt.CallStatus) && this.dialCallStatus !== CallStatus.Completed) {
      this.dialCallStatus = evt.CallStatus;
    }
    if (this.statusCallback) {
      const params = Object.assign({}, this.callAttributes, evt);
      const opts = {
        url: this.statusCallback,
        method: this.statusCallbackMethod,
        json: true,
        qs: 'GET' === this.statusCallbackMethod ? params : null,
        body: 'POST' === this.statusCallbackMethod ? params : null
      };
      request(opts, (err) => {
        if (err) this.logger.info(`TaskDial:Error sending call status to ${this.statusCallback}: ${err.message}`);
      });
    }
  }

  async _actionHook(cs) {
    if (this.action) {
      const params = {DialCallStatus: this.dialCallStatus};
      Object.assign(params, {
        DialCallSid: this.dialCallSid,
        DialCallDuration: this.dialCallDuration
      });
      const opts = {
        url: this.action,
        method: this.method,
        json: true,
        qs: 'GET' === this.method ? params : null,
        body: 'POST' === this.method ? params : null
      };

      return new Promise((resolve, reject) => {
        request(opts, (err, response, body) => {
          if (err) this.logger.info(`TaskDial:_actionHook sending call status to ${this.action}: ${err.message}`);
          if (body) {
            this.logger.debug(body, 'got new application payload');
            cs.replaceApplication(body);
          }
          resolve();
        });
      });
    }
  }
}

module.exports = TaskDial;
