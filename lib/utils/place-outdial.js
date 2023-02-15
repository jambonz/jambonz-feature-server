const Emitter = require('events');
const {CallStatus} = require('./constants');
const SipError = require('drachtio-srf').SipError;
const {TaskPreconditions, CallDirection} = require('../utils/constants');
const CallInfo = require('../session/call-info');
const assert = require('assert');
const { normalizeJambones } = require('@jambonz/verb-specifications');
const makeTask = require('../tasks/make_task');
const ConfirmCallSession = require('../session/confirm-call-session');
const AdultingCallSession = require('../session/adulting-call-session');
const deepcopy = require('deepcopy');
const moment = require('moment');
const stripCodecs = require('./strip-ancillary-codecs');
const RootSpan = require('./call-tracer');
const uuidv4 = require('uuid-random');

class SingleDialer extends Emitter {
  constructor({logger, sbcAddress, target, opts, application, callInfo, accountInfo, rootSpan, startSpan}) {
    super();
    assert(target.type);

    this.logger = logger;
    this.target = target;
    this.from = target.from || {};
    this.sbcAddress = sbcAddress;
    this.opts = opts;
    this.application = application;
    this.confirmHook = target.confirmHook;
    this.rootSpan = rootSpan;
    this.startSpan = startSpan;

    this.bindings = logger.bindings();

    this.parentCallInfo = callInfo;
    this.accountInfo = accountInfo;

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
    opts.headers = opts.headers || {};
    opts.headers = {
      ...opts.headers,
      ...(this.target.headers || {}),
      ...(this.from.user && {'X-Preferred-From-User': this.from.user}),
      ...(this.from.host && {'X-Preferred-From-Host': this.from.host}),
      'X-Jambonz-Routing': this.target.type,
      'X-Call-Sid': this.callSid,
      ...(this.applicationSid && {'X-Application-Sid': this.applicationSid})
    };
    if (srf.locals.fsUUID) {
      opts.headers = {
        ...opts.headers,
        'X-Jambonz-FS-UUID': srf.locals.fsUUID,
      };
    }
    this.ms = ms;
    let uri, to, inviteSpan;
    try {
      switch (this.target.type) {
        case 'phone':
        case 'teams':
          assert(this.target.number);
          uri = `sip:${this.target.number}@${this.sbcAddress}`;
          to = this.target.number;
          if ('teams' === this.target.type) {
            assert(this.target.teamsInfo);
            opts.headers = {...opts.headers,
              'X-MS-Teams-FQDN': this.target.teamsInfo.ms_teams_fqdn,
              'X-MS-Teams-Tenant-FQDN': this.target.teamsInfo.tenant_fqdn
            };
            if (this.target.vmail === true) uri = `${uri};opaque=app:voicemail`;
          }
          break;
        case 'user':
          assert(this.target.name);
          uri = `sip:${this.target.name}`;
          to = this.target.name;

          if (this.target.overrideTo) {
            Object.assign(opts.headers, {
              'X-Override-To': this.target.overrideTo
            });
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
      inviteSpan = this.startSpan('invite', {
        'invite.uri': uri,
        'invite.dest_type': this.target.type
      });

      this.dlg = await srf.createUAC(uri, {...opts,  followRedirects: true, keepUriOnRedirect: true}, {
        cbRequest: (err, req) => {
          if (err) {
            this.logger.error(err, 'SingleDialer:exec Error creating call');
            this.emit('callCreateFail', err);
            inviteSpan.setAttributes({
              'invite.status_code': 500,
              'invite.err': err.message
            });
            inviteSpan.end();
            return;
          }
          inviteSpan.setAttributes({'invite.call_id': req.get('Call-ID')});

          /**
           * INVITE has been sent out
           *  (a) create a CallInfo for this call
           *  (a) create a logger for this call
           */
          req.srf = srf;
          this.callInfo = new CallInfo({
            direction: CallDirection.Outbound,
            parentCallInfo: this.parentCallInfo,
            req,
            to,
            callSid: this.callSid,
            traceId: this.rootSpan.traceId
          });
          this.logger = srf.locals.parentLogger.child({
            callSid: this.callSid,
            parentCallSid: this.parentCallInfo.callSid,
            callId: this.callInfo.callId
          });
          this.inviteInProgress = req;
          this.emit('callStatusChange', {
            callStatus: CallStatus.Trying,
            sipStatus: 100,
            sipReason: 'Trying'
          });
        },
        cbProvisional: (prov) => {
          const status = {sipStatus: prov.status, sipReason: prov.reason};
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
      this.emit('callStatusChange', {
        sipStatus: 200,
        sipReason: 'OK',
        callStatus: CallStatus.InProgress
      });
      this.logger.debug(`SingleDialer:exec call connected: ${this.callSid}`);
      const connectTime = this.dlg.connectTime = moment();
      inviteSpan.setAttributes({'invite.status_code': 200});
      inviteSpan.end();


      /* race condition: we were killed just as call was answered */
      if (this.killed) {
        this.logger.info(`SingleDialer:exec race condition - we were killed as call connected: ${this.callSid}`);
        const duration = moment().diff(connectTime, 'seconds');
        this.emit('callStatusChange', {
          callStatus: CallStatus.Completed,
          sipStatus: 487,
          sipReason: 'Request Terminated',
          duration
        });
        if (this.ep) this.ep.destroy();
        return;
      }

      this.dlg
        .on('destroy', () => {
          const duration = moment().diff(connectTime, 'seconds');
          this.logger.debug('SingleDialer:exec called party hung up');
          this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
          this.ep && this.ep.destroy();
        })
        .on('refresh', () => this.logger.info('SingleDialer:exec - dialog refreshed by uas'))
        .on('modify', async(req, res) => {
          try {
            if (this.ep) {
              const newSdp = await this.ep.modify(req.body);
              res.send(200, {body: newSdp});
              this.logger.info({offer: req.body, answer: newSdp}, 'SingleDialer:exec: handling reINVITE');
            }
            else {
              this.logger.info('SingleDialer:exec: handling reINVITE with released media, emit event');
              this.emit('reinvite', req, res);
            }
          } catch (err) {
            this.logger.error(err, 'Error handling reinvite');
          }
        })
        .on('refer', (req, res) => {
          this.emit('refer', this.callInfo, req, res);
        });

      if (this.confirmHook) this._executeApp(this.confirmHook);
      else this.emit('accept');
    } catch (err) {
      this.inviteInProgress = null;
      const status = {callStatus: CallStatus.Failed};
      if (err instanceof SipError) {
        status.sipStatus = err.status;
        status.sipReason = err.reason;
        if (err.status === 487) status.callStatus = CallStatus.NoAnswer;
        else if ([486, 600].includes(err.status)) status.callStatus = CallStatus.Busy;
        this.logger.info(`SingleDialer:exec outdial failure ${err.status}`);
        inviteSpan.setAttributes({'invite.status_code': err.status});
        inviteSpan.end();
      }
      else {
        this.logger.error(err, 'SingleDialer:exec');
        status.sipStatus = 500;
        inviteSpan.setAttributes({
          'invite.status_code': 500,
          'invite.err': err.message
        });
        inviteSpan.end();
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
      const json = await this.requestor.request('dial:confirm', confirmHook, this.callInfo.toJSON());
      const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
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
        accountInfo: this.accountInfo,
        tasks,
        rootSpan: this.rootSpan
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

  async doAdulting({logger, tasks, application}) {
    this.adulting = true;
    this.emit('adulting');
    if (this.ep) {
      await this.ep.unbridge()
        .catch((err) => this.logger.info({err}, 'SingleDialer:doAdulting - failed to unbridge ep'));
      this.ep.play('silence_stream://1000');
    }
    else {
      await this.reAnchorMedia();
    }

    this.dlg.callSid = this.callSid;
    this.dlg.linkedSpanId = this.rootSpan.traceId;
    const rootSpan = new RootSpan('outbound-call', this.dlg);
    const newLogger = logger.child({traceId: rootSpan.traceId});
    const cs = new AdultingCallSession({
      logger: newLogger,
      singleDialer: this,
      application,
      callInfo: this.callInfo,
      accountInfo: this.accountInfo,
      tasks,
      rootSpan
    });
    cs.exec().catch((err) => newLogger.error({err}, 'doAdulting: error executing session'));
    return cs;
  }

  async releaseMediaToSBC(remoteSdp, localSdp) {
    assert(this.dlg && this.dlg.connected && this.ep && typeof remoteSdp === 'string');
    const sdp = stripCodecs(this.logger, remoteSdp, localSdp) || remoteSdp;
    await this.dlg.modify(sdp, {
      headers: {
        'X-Reason': 'release-media'
      }
    });
    this.ep.destroy()
      .then(() => this.ep = null)
      .catch((err) => this.logger.error({err}, 'SingleDialer:releaseMediaToSBC: Error destroying endpoint'));
  }

  async reAnchorMedia() {
    assert(this.dlg && this.dlg.connected && !this.ep);
    this.ep = await this.ms.createEndpoint({remoteSdp: this.dlg.remote.sdp});
    await this.dlg.modify(this.ep.local.sdp, {
      headers: {
        'X-Reason': 'anchor-media'
      }
    });
  }

  _notifyCallStatusChange({callStatus, sipStatus, sipReason, duration}) {
    assert((typeof duration === 'number' && callStatus === CallStatus.Completed) ||
      (!duration && callStatus !== CallStatus.Completed),
    'duration MUST be supplied when call completed AND ONLY when call completed');

    if (this.callInfo) {
      this.callInfo.updateCallStatus(callStatus, sipStatus, sipReason);
      if (typeof duration === 'number') this.callInfo.duration = duration;
      try {
        this.notifier.request('call:status', this.application.call_status_hook, this.callInfo.toJSON());
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

function placeOutdial({
  logger, srf, ms, sbcAddress, target, opts, application, callInfo, accountInfo, rootSpan, startSpan
}) {
  const myOpts = deepcopy(opts);
  const sd = new SingleDialer({
    logger, sbcAddress, target, myOpts, application, callInfo, accountInfo, rootSpan, startSpan
  });
  sd.exec(srf, ms, myOpts);
  return sd;
}

module.exports = placeOutdial;

