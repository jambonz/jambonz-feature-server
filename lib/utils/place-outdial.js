const Emitter = require('events');
const {CallStatus} = require('./constants');
const SipError = require('drachtio-srf').SipError;
const {TaskPreconditions, CallDirection} = require('../utils/constants');
const CallInfo = require('../session/call-info');
const assert = require('assert');
const ConfirmCallSession = require('../session/confirm-call-session');
const selectSbc = require('./select-sbc');
const Registrar = require('@jambonz/mw-registrar');
const registrar = new Registrar({
  host: process.env.JAMBONES_REDIS_HOST,
  port: process.env.JAMBONES_REDIS_PORT || 6379
});
const deepcopy = require('deepcopy');
const moment = require('moment');
const { v4: uuidv4 } = require('uuid');

class SingleDialer extends Emitter {
  constructor({logger, sbcAddress, target, opts, application, callInfo}) {
    super();
    assert(target.type);

    this.logger = logger;
    this.target = target;
    this.sbcAddress = sbcAddress;
    this.opts = opts;
    this.application = application;
    this.confirmHook = target.confirmHook;

    this.bindings = logger.bindings();

    this.parentCallInfo = callInfo;
    this.callGone = false;

    this.callSid = uuidv4();

    this.on('callStatusChange', this._notifyCallStatusChange.bind(this));
  }

  get callStatus() {
    return this.callInfo.callStatus;
  }

  /**
   * can be used for all http requests within this session
   */
  get requestor() {
    assert(this.application.requestor);
    return this.application.requestor;
  }

  /**
   * can be used for all http call status notifications within this session
   */
  get notifier() {
    assert(this.application.notifier);
    return this.application.notifier;
  }

  async exec(srf, ms, opts) {
    opts = opts || {};
    let uri, to;
    try {
      switch (this.target.type) {
        case 'phone':
        case 'teams':
          assert(this.target.number);
          uri = `sip:${this.target.number}@${this.sbcAddress}`;
          to = this.target.number;
          if ('teams' === this.target.type) {
            assert(this.target.teamsInfo);
            opts.headers = opts.headers || {};
            Object.assign(opts.headers, {
              'X-MS-Teams-FQDN': this.target.teamsInfo.ms_teams_fqdn,
              'X-MS-Teams-Tenant-FQDN': this.target.teamsInfo.tenant_fqdn
            });
            if (this.target.vmail === true) uri = `${uri};opaque=app:voicemail`;
          }
          break;
        case 'user':
          assert(this.target.name);
          const aor = this.target.name;
          uri = `sip:${this.target.name}`;
          to = this.target.name;

          // need to send to the SBC registered on
          const reg = await registrar.query(aor);
          if (reg) {
            const sbc = selectSbc(reg.sbcAddress);
            if (sbc) {
              this.logger.debug(`SingleDialer:exec retrieved registration details for ${aor}, using sbc at ${sbc}`);
              this.sbcAddress = sbc;
            }
          }
          break;
        case 'sip':
          assert(this.target.sipUri);
          uri = this.target.sipUri;
          to = this.target.sipUri;
          break;
        default:
          // should have been caught by parser
          assert(false, `invalid dial type ${this.target.type}: must be phone, user, or sip`);
      }

      this.updateCallStatus = srf.locals.dbHelpers.updateCallStatus;
      this.serviceUrl = srf.locals.serviceUrl;

      this.ep = await ms.createEndpoint();
      this.logger.debug(`SingleDialer:exec - created endpoint ${this.ep.uuid}`);

      /**
       * were we killed whilst we were off getting an endpoint ?
       * https://github.com/jambonz/jambonz-feature-server/issues/30
       */
      if (this.killed) {
        this.logger.info('SingleDialer:exec got quick CANCEL from caller, abort outdial');
        this.ep.destroy()
          .catch((err) => this.logger.error({err}, 'Error destroying endpoint'));
        return;
      }
      let lastSdp;
      const connectStream = async(remoteSdp) => {
        if (remoteSdp === lastSdp) return;
        lastSdp = remoteSdp;
        return this.ep.modify(remoteSdp);
      };

      Object.assign(opts, {
        proxy: `sip:${this.sbcAddress}`,
        localSdp: this.ep.local.sdp
      });
      if (this.target.auth) opts.auth = this.target.auth;
      this.dlg = await srf.createUAC(uri, opts, {
        cbRequest: (err, req) => {
          if (err) {
            this.logger.error(err, 'SingleDialer:exec Error creating call');
            this.emit('callCreateFail', err);
            return;
          }

          /**
           * INVITE has been sent out
           *  (a) create a CallInfo for this call
           *  (a) create a logger for this call
           */
          this.callInfo = new CallInfo({
            direction: CallDirection.Outbound,
            parentCallInfo: this.parentCallInfo,
            req,
            to,
            callSid: this.callSid
          });
          this.logger = srf.locals.parentLogger.child({
            callSid: this.callSid,
            parentCallSid: this.parentCallInfo.callSid,
            callId: this.callInfo.callId
          });
          this.inviteInProgress = req;
          this.emit('callStatusChange', {callStatus: CallStatus.Trying, sipStatus: 100});
        },
        cbProvisional: (prov) => {
          const status = {sipStatus: prov.status};
          if ([180, 183].includes(prov.status) && prov.body) {
            if (status.callStatus !== CallStatus.EarlyMedia) {
              status.callStatus = CallStatus.EarlyMedia;
              this.emit('earlyMedia');
            }
            connectStream(prov.body);
          }
          else status.callStatus = CallStatus.Ringing;
          this.emit('callStatusChange', status);
        }
      });
      await connectStream(this.dlg.remote.sdp);
      this.dlg.callSid = this.callSid;
      this.inviteInProgress = null;
      this.emit('callStatusChange', {sipStatus: 200, callStatus: CallStatus.InProgress});
      this.logger.debug(`SingleDialer:exec call connected: ${this.callSid}`);
      const connectTime = this.dlg.connectTime = moment();

      this.dlg
        .on('destroy', () => {
          const duration = moment().diff(connectTime, 'seconds');
          this.logger.debug('SingleDialer:exec called party hung up');
          this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
          this.ep.destroy();
        })
        .on('refresh', () => this.logger.info('SingleDialer:exec - dialog refreshed by uas'))
        .on('modify', async(req, res) => {
          try {
            const newSdp = await this.ep.modify(req.body);
            res.send(200, {body: newSdp});
            this.logger.info({offer: req.body, answer: newSdp}, 'SingleDialer:exec: handling reINVITE');
          } catch (err) {
            this.logger.error(err, 'Error handling reinvite');
          }
        });

      if (this.confirmHook) this._executeApp(this.confirmHook);
      else this.emit('accept');
    } catch (err) {
      const status = {callStatus: CallStatus.Failed};
      if (err instanceof SipError) {
        status.sipStatus = err.status;
        if (err.status === 487) status.callStatus = CallStatus.NoAnswer;
        else if ([486, 600].includes(err.status)) status.callStatus = CallStatus.Busy;
        this.logger.info(`SingleDialer:exec outdial failure ${err.status}`);
      }
      else {
        this.logger.error(err, 'SingleDialer:exec');
        status.sipStatus = 500;
      }
      this.emit('callStatusChange', status);
      if (this.ep) this.ep.destroy();
    }
  }

  /**
   * kill the call in progress or the stable dialog, whichever we have
   */
  async kill() {
    this.killed = true;
    if (this.inviteInProgress) await this.inviteInProgress.cancel();
    else if (this.dlg && this.dlg.connected) {
      const duration = moment().diff(this.dlg.connectTime, 'seconds');
      this.logger.debug('SingleDialer:kill hanging up called party');
      this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
      this.dlg.destroy();
    }
    if (this.ep) {
      this.logger.debug(`SingleDialer:kill - deleting endpoint ${this.ep.uuid}`);
      await this.ep.destroy();
    }
  }

  /**
   * Run an application on the call after answer, e.g. call screening.
   * Once the application completes in some fashion, emit an 'accepted' event
   * if the call is still up/connected, a 'decline' otherwise.
   * Note: the application to run may not include a dial or sip:decline verb
   * @param {*} url - url for application
   */
  async _executeApp(confirmHook) {
    try {
      // retrieve set of tasks
      const tasks = await this.requestor.request(confirmHook, this.callInfo);

      // verify it contains only allowed verbs
      const allowedTasks = tasks.filter((task) => {
        return [
          TaskPreconditions.StableCall,
          TaskPreconditions.Endpoint
        ].includes(task.preconditions);
      });
      if (tasks.length !== allowedTasks.length) {
        throw new Error('unsupported verb in dial url');
      }

      // now execute it in a new ConfirmCallSession
      this.logger.debug(`SingleDialer:_executeApp: executing ${tasks.length} tasks`);
      const cs = new ConfirmCallSession({
        logger: this.logger,
        application: this.application,
        dlg: this.dlg,
        ep: this.ep,
        callInfo: this.callInfo,
        tasks
      });
      await cs.exec();

      // still connected after app is completed?  Signal parent call we are good
      this.emit(this.dlg.connected ? 'accept' : 'decline');
    } catch (err) {
      this.logger.debug(err, 'SingleDialer:_executeApp: error');
      this.emit('decline');
      if (this.dlg.connected) this.dlg.destroy();
    }
  }

  _notifyCallStatusChange({callStatus, sipStatus, duration}) {
    assert((typeof duration === 'number' && callStatus === CallStatus.Completed) ||
      (!duration && callStatus !== CallStatus.Completed),
    'duration MUST be supplied when call completed AND ONLY when call completed');

    if (this.callInfo) {
      this.callInfo.updateCallStatus(callStatus, sipStatus);
      if (typeof duration === 'number') this.callInfo.duration = duration;
      try {
        this.requestor.request(this.application.call_status_hook, this.callInfo.toJSON());
      } catch (err) {
        this.logger.info(err, `SingleDialer:_notifyCallStatusChange error sending ${callStatus} ${sipStatus}`);
      }
      // update calls db
      this.updateCallStatus(this.callInfo, this.serviceUrl).catch((err) => this.logger.error(err, 'redis error'));
    }
    else {
      this.logger.info('SingleDialer:_notifyCallStatusChange: call status change before sending the outbound INVITE!!');
    }
  }
}

function placeOutdial({logger, srf, ms, sbcAddress, target, opts, application, callInfo}) {
  const myOpts = deepcopy(opts);
  const sd = new SingleDialer({logger, sbcAddress, target, myOpts, application, callInfo});
  sd.exec(srf, ms, myOpts);
  return sd;
}

module.exports = placeOutdial;

