const Task = require('./task');
const makeTask = require('./make_task');
const {
  CallStatus,
  CallDirection,
  TaskName,
  TaskPreconditions,
  MAX_SIMRINGS,
  MediaPath,
  KillReason
} = require('../utils/constants');
const assert = require('assert');
const placeCall = require('../utils/place-outdial');
const sessionTracker = require('../session/session-tracker');
const DtmfCollector = require('../utils/dtmf-collector');
const ConfirmCallSession = require('../session/confirm-call-session');
const dbUtils = require('../utils/db-utils');
const parseDecibels = require('../utils/parse-decibels');
const debug = require('debug')('jambonz:feature-server');
const {parseUri} = require('drachtio-srf');
const {ANCHOR_MEDIA_ALWAYS,
  JAMBONZ_DISABLE_DIAL_PAI_HEADER,
  JAMBONES_DIAL_SBC_FOR_REGISTERED_USER} = require('../config');
const { isOnhold, isOpusFirst } = require('../utils/sdp-utils');
const { normalizeJambones } = require('@jambonz/verb-specifications');
const { selectHostPort } = require('../utils/network');

function parseDtmfOptions(logger, dtmfCapture) {
  let parentDtmfCollector, childDtmfCollector;
  const parentKeys = [], childKeys = [];

  if (Array.isArray(dtmfCapture)) {
    Array.prototype.push.apply(parentKeys, dtmfCapture);
    Array.prototype.push.apply(childKeys, dtmfCapture);
  }
  else if (dtmfCapture.childCall || dtmfCapture.parentCall) {
    if (dtmfCapture.childCall && Array.isArray(dtmfCapture.childCall)) {
      Array.prototype.push.apply(childKeys, dtmfCapture.childCall);
    }
    if (dtmfCapture.parentCall && Array.isArray(dtmfCapture.parentCall)) {
      Array.prototype.push.apply(childKeys, dtmfCapture.parentCall);
    }
  }
  if (childKeys.length) {
    childDtmfCollector = new DtmfCollector({logger, patterns: childKeys});
  }
  if (parentKeys.length) {
    parentDtmfCollector = new DtmfCollector({logger, patterns: parentKeys});
  }

  return {childDtmfCollector, parentDtmfCollector};
}

function compareTasks(t1, t2) {
  if (t1.type !== t2.type) return false;
  switch (t1.type) {
    case 'phone':
      return t1.number === t2.number;
    case 'user':
      return t1.name === t2.name;
    case 'teams':
      return t1.number === t2.number;
    case 'sip':
      return t1.sipUri === t2.sipUri;
  }
}

/**
 * Allow at most 10 targets and eliminate duplicates
 */
function filterAndLimit(logger, tasks) {
  assert(Array.isArray(tasks));
  const unique = tasks.reduce((acc, t) => {
    if (acc.find((el) => compareTasks(el, t))) return acc;
    return [...acc, t];
  }, []);

  if (unique.length !== tasks.length) {
    logger.info(`filterAndLimit: removed ${tasks.length - unique.length} duplicate dial targets`);
  }

  if (unique.length > MAX_SIMRINGS) {
    logger.info(`filterAndLimit: max number of targets exceeded: ${unique.length}; first ${MAX_SIMRINGS} will be used`);
    unique.length = MAX_SIMRINGS;
  }
  return unique;
}

const sleepFor = (ms) => new Promise((resolve) => setTimeout(() => resolve(), ms));

class TaskDial extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.None;

    this.earlyMedia = this.data.answerOnBridge === true;
    this.callerId = this.data.callerId;
    this.callerName = this.data.callerName;
    this.dialMusic = this.data.dialMusic;
    this.headers = this.data.headers || {};
    this.method = this.data.method || 'POST';
    this.target = filterAndLimit(this.logger, this.data.target);
    this.timeout = this.data.timeout || 60;
    this.timeLimit = this.data.timeLimit;
    this.confirmHook = this.data.confirmHook;
    this.confirmMethod = this.data.confirmMethod;
    this.referHook = this.data.referHook;
    this.dtmfHook = this.data.dtmfHook;
    this.proxy = this.data.proxy;
    this.tag = this.data.tag;
    this.boostAudioSignal = this.data.boostAudioSignal;
    this._mediaPath = MediaPath.FullMedia;

    if (this.dtmfHook) {
      const {parentDtmfCollector, childDtmfCollector} = parseDtmfOptions(logger, this.data.dtmfCapture || {});
      if (parentDtmfCollector) {
        this.parentDtmfCollector = parentDtmfCollector;
      }
      if (childDtmfCollector) {
        this.childDtmfCollector = childDtmfCollector;
      }
    }

    if (this.data.listen) {
      this.listenTask = makeTask(logger, {'listen': this.data.listen}, this);
    }
    if (this.data.transcribe) {
      this.transcribeTask = makeTask(logger, {'transcribe' : this.data.transcribe}, this);
    }
    if (this.data.dub && Array.isArray(this.data.dub) && this.data.dub.length > 0) {
      this.dubTasks = this.data.dub.map((d) => makeTask(logger, {'dub': d}, this));
    }

    this.results = {};
    this.bridged = false;
    this.dials = new Map();
  }

  get dlg() {
    if (this.sd) return this.sd.dlg;
  }

  get ep() {
    /**
     * Note:
     *        this.ep is the B leg-facing endpoint
     *        this.epOther is the A leg-facing endpoint
     */
    if (this.sd) return this.sd.ep;
  }

  get name() { return TaskName.Dial; }

  get isOnHoldEnabled() {
    return !!this.data.onHoldHook;
  }

  get canReleaseMedia() {
    const keepAnchor = this.data.anchorMedia ||
      this.cs.isBackGroundListen ||
      this.cs.onHoldMusic ||
      ANCHOR_MEDIA_ALWAYS ||
      this.listenTask ||
      this.dubTasks ||
      this.transcribeTask ||
      this.startAmd;

    return !keepAnchor;
  }

  get shouldExitMediaPathEntirely() {
    return this.data.exitMediaPath;
  }

  get summary() {
    if (this.target.length === 1) {
      const target = this.target[0];
      switch (target.type) {
        case 'phone':
        case 'teams':
          return `${this.name}{type=${target.type},number=${target.number}}`;
        case 'user':
          return `${this.name}{type=${target.type},name=${target.name}}`;
        case 'sip':
          return `${this.name}{type=${target.type},sipUri=${target.sipUri}}`;
        default:
          return `${this.name}`;
      }
    }
    else return `${this.name}{${this.target.length} targets}`;
  }

  async exec(cs) {
    await super.exec(cs);

    if (this.data.anchorMedia && this.data.exitMediaPath) {
      this.logger.info('Dial:exec - incompatible anchorMedia and exitMediaPath are both set, will obey anchorMedia');
      delete this.data.exitMediaPath;
    }
    if (!this.canReleaseMedia && this.data.exitMediaPath) {
      this.logger.info(
        'Dial:exec - exitMediaPath is set so features such as transcribe and record will not work on this call');
    }

    try {
      if (this.listenTask) {
        const {span, ctx} = this.startChildSpan(`nested:${this.listenTask.summary}`);
        this.listenTask.span = span;
        this.listenTask.ctx = ctx;
      }
      if (this.transcribeTask) {
        const {span, ctx} = this.startChildSpan(`nested:${this.transcribeTask.summary}`);
        this.transcribeTask.span = span;
        this.transcribeTask.ctx = ctx;
      }
      if (this.data.amd) {
        this.startAmd = cs.startAmd;
        this.stopAmd = cs.stopAmd;
        this.on('amd', this._onAmdEvent.bind(this, cs));
      }
      if (cs.direction === CallDirection.Inbound) {
        await this._initializeInbound(cs);
      }
      else {
        this.epOther = cs.ep;
        if (this.dialMusic && this.epOther && this.epOther.connected) {
          (async() => {
            do {
              try {
                await this.epOther.play(this.dialMusic);
              } catch (err) {
                this.logger.error(err, `TaskDial:exec error playing ${this.dialMusic}`);
                await sleepFor(1000);
              }
            } while (!this.killed || !this.bridged);
          })();
        }
      }
      if (!this.killed) await this._attemptCalls(cs);
      await this.awaitTaskDone();
      this.logger.debug({callSid: this.cs.callSid}, 'Dial:exec task is done, sending actionHook if any');
      await this.performAction(this.results, this.killReason !== KillReason.Replaced);
      this._removeDtmfDetection(cs.dlg);
      this._removeDtmfDetection(this.dlg);
      this._removeSipIndialogRequestListener(this.dlg);
    } catch (err) {
      this.logger.error({err}, 'TaskDial:exec terminating with error');
      this.kill(cs);
    }
  }

  async kill(cs, reason) {
    super.kill(cs);
    try {
      if (this.ep && this.ep.amd) this.stopAmd(this.ep, this);
    } catch (err) {
      this.logger.error({err}, 'DialTask:kill - error stopping answering machine detectin');
    }
    if (this.dialMusic && this.epOther) {
      this.epOther.api('uuid_break', this.epOther.uuid)
        .catch((err) => this.logger.info(err, 'Error killing dialMusic'));
    }
    this.killReason = reason || KillReason.Hangup;
    if (this.timerMaxCallDuration) {
      clearTimeout(this.timerMaxCallDuration);
      this.timerMaxCallDuration = null;
    }
    if (this.timerRing) {
      clearTimeout(this.timerRing);
      this.timerRing = null;
    }
    this._removeDtmfDetection(cs.dlg);
    this._removeDtmfDetection(this.dlg);
    await this._killOutdials();
    if (this.sd) {
      this.sd.kill();
      this.sd.removeAllListeners();
      this.sd = null;
    }
    if (this.callSid) sessionTracker.remove(this.callSid);
    if (this.listenTask) {
      await this.listenTask.kill(cs);
      this.listenTask.span.end();
      this.listenTask = null;
    }
    if (this.transcribeTask) {
      await this.transcribeTask.kill(cs);
      this.transcribeTask.span.end();
      this.transcribeTask = null;
    }
    this.notifyTaskDone();
  }

  /**
   * whisper a prompt to one side of the call
   * @param {*} tasks - array of play/say tasks to execute
   */
  async whisper(tasks, callSid) {
    try {
      const cs = this.callSession;
      if (!this.ep && !this.epOther) {
        await this.reAnchorMedia(this.callSession, this.sd);
      }

      if (!this.epOther || !this.ep) return this.logger.info('Dial:whisper: no paired endpoint found');

      this.logger.debug('Dial:whisper unbridging endpoints');
      await this.epOther.unbridge();
      this.logger.debug('Dial:whisper executing tasks');
      while (tasks.length && !cs.callGone) {
        const task = tasks.shift();
        const {span, ctx} = this.startChildSpan(`whisper:${task.summary}`);
        task.span = span;
        task.ctx = ctx;
        await task.exec(cs, callSid === this.callSid ? {ep: this.ep} : {ep: this.epOther});
        span.end();
      }
      this.logger.debug('Dial:whisper tasks complete');
      if (!cs.callGone && this.epOther) {

        /* if we can release the media back to the SBC, do so now */
        if (this.canReleaseMedia) this._releaseMedia(cs, this.sd, this.shouldExitMediaPathEntirely);
        else this.epOther.bridge(this.ep);
      }
    } catch (err) {
      this.logger.error(err, 'Dial:whisper error');
    }
  }

  /**
   * mute or unmute one side of the call
   */
  async mute(callSid, doMute) {
    const parentCall = callSid !== this.callSid;
    const dlg = parentCall ? this.callSession.dlg : this.dlg;
    const hdr = `${doMute ? 'mute' : 'unmute'} call leg`;
    try {
      /* let rtpengine do the mute / unmute */
      await dlg.request({
        method: 'INFO',
        headers: {
          'X-Reason': hdr
        }
      });
    } catch (err) {
      this.logger.info({err}, `Dial:mute - ${hdr} error`);
    }
  }

  async handleRefer(cs, req, res, callInfo = cs.callInfo) {
    if (this.referHook) {
      try {
        const isChild = !!callInfo.parentCallSid;
        const referring_call_sid = isChild ? callInfo.callSid : cs.callSid;
        const referred_call_sid = isChild ? callInfo.parentCallSid : this.sd.callSid;

        const b3 = this.getTracingPropagation();
        const httpHeaders = b3 && {b3};

        const to = parseUri(req.getParsedHeader('Refer-To').uri);
        const by = parseUri(req.getParsedHeader('Referred-By').uri);
        const referredBy = req.get('Referred-By');
        const userAgent = req.get('User-Agent');
        const customHeaders = Object.keys(req.headers)
          .filter((h) => h.toLowerCase().startsWith('x-'))
          .reduce((acc, h) => {
            acc[h] = req.get(h);
            return acc;
          }, {});
        this.logger.info({to}, 'refer to parsed');
        const json = await cs.requestor.request('verb:hook', this.referHook, {
          ...(callInfo.toJSON()),
          refer_details: {
            sip_refer_to: req.get('Refer-To'),
            refer_to_user: to.scheme === 'tel' ? to.number : to.user,
            ...(referredBy && {sip_referred_by: referredBy}),
            ...(userAgent && {sip_user_agent: userAgent}),
            ...(by && {referred_by_user: by.scheme === 'tel' ? by.number : by.user}),
            referring_call_sid,
            referred_call_sid,
            ...customHeaders
          }
        }, httpHeaders);
        if (json && Array.isArray(json)) {
          try {
            const logger = isChild ? this.logger : this.sd.logger;
            const tasks = normalizeJambones(logger, json).map((tdata) => makeTask(this.logger, tdata));
            if (tasks && tasks.length > 0) {
              const legs = isChild ? ['child', 'parent'] : ['parent', 'child'];
              logger.info(`Dial:handleRefer received REFER on ${legs[0]} leg, setting new app on ${legs[1]} leg`);
              if (isChild) this.redirect(cs, tasks);
              else {
                logger.info({tasks: json}, 'Dial:handleRefer - new application for for child leg');
                const adultingSession = await this.sd.doAdulting({
                  logger,
                  application: cs.application,
                  tasks
                });
                /* need to update the callSid of the child with its own (new) AdultingCallSession */
                sessionTracker.add(adultingSession.callSid, adultingSession);
              }
            }
          } catch (err) {
            this.logger.info(err, 'Dial:handleRefer - error setting new application after receiving REFER');
          }
        }
        //caller and callee legs are briged together, accept refer with 202 will release callee leg endpoint
        //that makes freeswitch release endpoint for caller leg.
        if (this.ep) this.ep.unbridge();
        res.send(202);
        this.logger.info('DialTask:handleRefer - sent 202 Accepted');
      } catch (err) {
        this.logger.info({err}, 'DialTask:handleRefer - error processing incoming REFER');
        res.send(err.statusCode || 501);
      }
    }
    else {
      this.logger.info('DialTask:handleRefer - got REFER but no referHook, responding 501');
      res.send(501);
    }
  }

  _removeHandlers(sd) {
    sd.removeAllListeners('accept');
    sd.removeAllListeners('decline');
    sd.removeAllListeners('adulting');
    sd.removeAllListeners('callStatusChange');
    sd.removeAllListeners('callCreateFail');
  }

  async _killOutdials() {
    for (const [callSid, sd] of Array.from(this.dials)) {
      this.logger.debug(`Dial:_killOutdials killing callSid ${callSid}`);
      try {
        await sd.kill();
      } catch (err) {
        this.logger.info(err, `Dial:_killOutdials Error killing ${callSid}`);
      }
      this._removeHandlers(sd);
      this.logger.debug(`Dial:_killOutdials killed callSid ${callSid}`);
    }
    this.dials.clear();
  }

  _installDtmfDetection(cs, dlg) {
    dlg.on('info', this._onInfo.bind(this, cs, dlg));
  }
  _removeDtmfDetection(dlg) {
    dlg && dlg.removeAllListeners('info');
  }

  _onInfo(cs, dlg, req, res) {
    // SIP Indialog will be handled by another handler
    if (cs.sipRequestWithinDialogHook) {
      return;
    }
    res.send(200);
    if (req.get('Content-Type') !== 'application/dtmf-relay') {
      return;
    }

    const dtmfDetector = dlg === cs.dlg ? this.parentDtmfCollector : this.childDtmfCollector;
    if (!dtmfDetector) return;
    let requestor, callSid, callInfo;
    if (dtmfDetector === this.parentDtmfCollector) {
      requestor = cs.requestor;
      callSid = cs.callSid;
      callInfo = cs.callInfo;
    }
    else {
      requestor = this.sd?.requestor;
      callSid = this.sd?.callSid;
      callInfo = this.sd?.callInfo;
    }
    if (!requestor) return;
    const arr = /Signal=([0-9#*])/.exec(req.body);
    if (!arr) return;
    const key = arr[1];
    const match = dtmfDetector.keyPress(key);
    if (match) {
      const b3 = this.getTracingPropagation();
      const httpHeaders = b3 && {b3};
      this.logger.info({callSid}, `Dial:_onInfo triggered dtmf match: ${match}`);
      requestor.request('verb:hook', this.dtmfHook, {dtmf: match, ...callInfo.toJSON()}, httpHeaders)
        .catch((err) => this.logger.info(err, 'Dial:_onDtmf - error'));
    }
  }

  _initSipIndialogRequestListener(cs, dlg) {
    dlg.on('info', this._onRequestWithinDialog.bind(this, cs));
    dlg.on('message', this._onRequestWithinDialog.bind(this, cs));
  }

  _removeSipIndialogRequestListener(dlg) {
    dlg && dlg.removeAllListeners('message');
    dlg && dlg.removeAllListeners('info');
  }

  async _onRequestWithinDialog(cs, req, res) {
    cs._onRequestWithinDialog(req, res);
  }

  async _initializeInbound(cs) {
    const {ep} = await cs._evalEndpointPrecondition(this);
    this.epOther = ep;

    /* send outbound legs back to the same SBC (to support static IP feature) */
    if (!this.proxy) this.proxy = `${cs.req.source_address}:${cs.req.source_port}`;

    if (this.dialMusic) {
      // play dial music to caller while we outdial
      ep.play(this.dialMusic).catch((err) => {
        this.logger.error(err, `TaskDial:_initializeInbound - error playing ${this.dialMusic}`);
      });
    }
  }

  async _attemptCalls(cs) {
    const {req, callInfo, direction, srf} = cs;
    const {getSBC} = srf.locals;
    const {lookupTeamsByAccount, lookupAccountBySid} = srf.locals.dbHelpers;
    const {lookupCarrier, lookupCarrierByPhoneNumber} = dbUtils(this.logger, cs.srf);
    let sbcAddress = this.proxy || getSBC();
    const teamsInfo = {};
    let fqdn;

    if (!sbcAddress) throw new Error('no SBC found for outbound call');
    this.headers = {
      'X-Account-Sid': cs.accountSid,
      ...(req && req.has('X-CID') && {'X-CID': req.get('X-CID')}),
      ...(direction === 'outbound' && callInfo.sbcCallid && {'X-CID': callInfo.sbcCallid}),
      ...(!JAMBONZ_DISABLE_DIAL_PAI_HEADER && req && {
        ...(req.has('P-Asserted-Identity') && {'P-Asserted-Identity': req.get('P-Asserted-Identity')}),
        ...(req.has('Privacy') && {'Privacy': req.get('Privacy')}),
      }),
      ...(req && req.has('X-Voip-Carrier-Sid') && {'X-Voip-Carrier-Sid': req.get('X-Voip-Carrier-Sid')}),
      // Put headers at the end to make sure opt.headers override all default behavior.
      ...this.headers
    };

    // get calling user from From header
    const parsedFrom = req.getParsedHeader('from');
    const fromUri = parseUri(parsedFrom.uri);
    const opts = {
      headers: this.headers,
      proxy: `sip:${sbcAddress}`,
      callingNumber: this.callerId || fromUri.user,
      ...(this.callerName && {callingName: this.callerName}),
      opusFirst: isOpusFirst(this.cs.ep.remote.sdp)
    };

    const t = this.target.find((t) => t.type === 'teams');
    if (t) {
      const obj = await lookupTeamsByAccount(cs.accountSid);
      if (!obj) throw new Error('dial to ms teams not allowed; account must first be configured with teams info');
      Object.assign(teamsInfo, {tenant_fqdn: t.tenant || obj.tenant_fqdn, ms_teams_fqdn: obj.ms_teams_fqdn});
    }

    const ms = await cs.getMS();
    this.timerRing = setTimeout(async() => {
      this.logger.info(`Dial:_attemptCall: ring no answer timer ${this.timeout}s exceeded`);
      this.timerRing = null;
      try {
        await this._killOutdials();
      } catch (err) {
        this.logger.info(err, 'Dial:_attemptCall - error killing outdials');
      }
      this.result = {
        dialCallStatus: CallStatus.NoAnswer,
        dialSipStatus: 487
      };
      this.kill(cs);
    }, this.timeout * 1000);

    this.span.setAttributes({'dial.target': JSON.stringify(this.target)});
    this.target.forEach(async(t) => {
      try {
        t.confirmHook = t.confirmHook || this.confirmHook;
        //t.method = t.method || this.confirmMethod || 'POST';
        if (t.type === 'teams') t.teamsInfo = teamsInfo;
        if (t.type === 'user' && !t.name.includes('@') && !fqdn) {
          const user = t.name;
          try {
            const {sip_realm} = await lookupAccountBySid(cs.accountSid);
            if (sip_realm) {
              t.name = `${user}@${sip_realm}`;
              this.logger.debug(`appending sip realm ${sip_realm} to dial target user ${user}`);
            }
          } catch (err) {
            this.logger.error({err}, 'Error looking up account by sid');
          }
        }
        // find handling sbc sip for called user
        if (JAMBONES_DIAL_SBC_FOR_REGISTERED_USER && t.type === 'user') {
          const { registrar }  = srf.locals.dbHelpers;
          const reg = await registrar.query(t.name);
          if (reg) {
            sbcAddress = selectHostPort(this.logger, reg.sbcAddress, 'tcp')[1];
          }
          //sbc outbound return 404 Notfound to handle case called user is not reigstered.
        }
        if (t.type === 'phone' && t.trunk) {
          const voip_carrier_sid = await lookupCarrier(cs.accountSid, t.trunk);
          this.logger.info(`Dial:_attemptCalls: selected ${voip_carrier_sid} for requested carrier: ${t.trunk}`);
          if (voip_carrier_sid) {
            opts.headers['X-Requested-Carrier-Sid'] = voip_carrier_sid;
          }
        }

        /**
         * trunk isn't specified,
         * check if number matches any existing numbers
         *  */
        if (t.type === 'phone' && !t.trunk) {
          const str = this.callerId || req.callingNumber || '';
          const callingNumber = str.startsWith('+') ? str.substring(1) : str;
          const voip_carrier_sid = await lookupCarrierByPhoneNumber(cs.accountSid, callingNumber);
          if (voip_carrier_sid) {
            this.logger.info(
              `Dial:_attemptCalls: selected voip_carrier_sid ${voip_carrier_sid} for callingNumber: ${callingNumber}`);
            opts.headers['X-Requested-Carrier-Sid'] = voip_carrier_sid;
          }
        }

        if (this.killed) return;

        const sd = placeCall({
          logger: this.logger,
          application: cs.application,
          srf,
          ms,
          sbcAddress,
          target: t,
          opts,
          callInfo: cs.callInfo,
          accountInfo: cs.accountInfo,
          rootSpan: cs.rootSpan,
          startSpan: this.startSpan.bind(this),
          dialTask: this,
          onHoldMusic: this.cs.onHoldMusic
        });
        this.dials.set(sd.callSid, sd);

        sd
          .on('refer', (callInfo, req, res) => this.handleRefer(cs, req, res, callInfo))
          .on('callCreateFail', () => {
            clearTimeout(this.timerRing);
            this.dials.delete(sd.callSid);
            sd.removeAllListeners();
            if (this.dials.size === 0 && !this.sd) {
              this.logger.debug('Dial:_attemptCalls - all calls failed after call create err, ending task');
              this.kill(cs);
            }
          })
          .on('callStatusChange', (obj) => {
            if (this.results.dialCallStatus !== CallStatus.Completed &&
              this.results.dialCallStatus !== CallStatus.NoAnswer) {
              Object.assign(this.results, {
                dialCallStatus: obj.callStatus,
                dialSipStatus: obj.sipStatus,
                dialCallSid: sd.callSid,
                dialSbcCallid: sd.callInfo.sbcCallid
              });
            }
            switch (obj.callStatus) {
              case CallStatus.Trying:
                break;
              case CallStatus.EarlyMedia:
                if (this.target.length === 1 && !this.target[0].url && !this.dialMusic) {
                  this._bridgeEarlyMedia(sd);
                }
                break;
              case CallStatus.InProgress:
                this.logger.debug('Dial:_attemptCall -- call was answered');
                clearTimeout(this.timerRing);
                this.timerRing = null;
                break;
              case CallStatus.Failed:
              case CallStatus.Busy:
              case CallStatus.NoAnswer:
                this.dials.delete(sd.callSid);
                if (this.dials.size === 0 && !this.sd) {
                  this.logger.debug('Dial:_attemptCalls - all calls failed after call failure, ending task');
                  clearTimeout(this.timerRing);
                  this.timerRing = null;
                  this.kill(cs);
                }
                break;
            }
          })
          .on('accept', async() => {
            this.logger.debug(`Dial:_attemptCalls - we have a winner: ${sd.callSid}`);
            clearTimeout(this.timerRing);
            try {
              await this._connectSingleDial(cs, sd);
            } catch (err) {
              this.logger.info({err}, 'Dial:_attemptCalls - Error calling _connectSingleDial ');
              sd.removeAllListeners();
              this.kill(cs);
            }
          })
          .on('decline', () => {
            this.logger.debug(`Dial:_attemptCalls - declined: ${sd.callSid}`);
            clearTimeout(this.timerRing);
            this.dials.delete(sd.callSid);
            sd.removeAllListeners();
            if (this.dials.size === 0 && !this.sd) {
              this.logger.debug('Dial:_attemptCalls - all calls failed after decline, ending task');
              this.kill(cs);
            }
          })
          .on('reinvite', (req, res) => {
            this._onReinvite(req, res);
          })
          .on('refer', (callInfo, req, res) => {

          })
          .once('adulting', () => {
            /* child call just adulted and got its own session */
            this.logger.info('Dial:on_adulting: detaching child call leg');
            if (this.ep) {
              this.logger.debug(`Dial:on_adulting: removing dtmf from ${this.ep.uuid}`);
              this.ep.removeAllListeners('dtmf');
            }
            this.sd = null;
            this.callSid = null;
          });
      } catch (err) {
        this.logger.error(err, 'Dial:_attemptCalls');
      }
    });
  }

  async _connectSingleDial(cs, sd) {
    if (!this.bridged && !this.canReleaseMedia) {
      this.logger.debug('Dial:_connectSingleDial bridging endpoints');
      if (this.epOther) {
        this.epOther.api('uuid_break', this.epOther.uuid);
        this.epOther.bridge(sd.ep);
      }
      this.bridged = true;
    }

    // ding! ding! ding! we have a winner
    await this._selectSingleDial(cs, sd);
    this._killOutdials();       // NB: order is important
  }

  async _onReinvite(req, res) {
    try {
      let isHandled = false;
      if (this.isOnHoldEnabled) {
        if (isOnhold(req.body)) {
          this.logger.debug('Dial: _onReinvite receive hold Request');
          if (!this.epOther && !this.ep) {
            this.logger.debug(`Dial: _onReinvite receive hold Request,
 media already released, reconnect media server`);
            // update caller leg for new SDP from callee.
            await this.cs.handleReinviteAfterMediaReleased(req, res);
            // Freeswitch media is released, reconnect
            await this.reAnchorMedia(this.cs, this.sd);
            this.isOutgoingLegHold = true;
          } else {
            this.logger.debug('Dial: _onReinvite receive hold Request, update SDP');
            const newSdp = await this.ep.modify(req.body);
            res.send(200, {body: newSdp});
          }
          isHandled = true;
          // Media already connected, ask for onHoldHook
          this._onHoldHook(req);
        } else if (!isOnhold(req.body)) {
          this.logger.debug('Dial: _onReinvite receive unhold Request');
          if (this.epOther && this.ep && this.isOutgoingLegHold && this.canReleaseMedia) {
            this.logger.debug('Dial: _onReinvite receive unhold Request, release media');
            // Offhold, time to release media
            const newSdp = await this.ep.modify(req.body);
            await res.send(200, {body: newSdp});
            await this._releaseMedia(this.cs, this.sd, this.shouldExitMediaPathEntirely);
            this.isOutgoingLegHold = false;
          } else {
            this.logger.debug('Dial: _onReinvite receive unhold Request, update media server');
            const newSdp = await this.ep.modify(req.body);
            res.send(200, {body: newSdp});
          }
          if (this._onHoldSession) {
            this._onHoldSession.kill();
          }
          isHandled = true;
        }
      }
      if (!isHandled) {
        this.cs.handleReinviteAfterMediaReleased(req, res);
      }
    } catch (err) {
      this.logger.error(err, 'Error in dial einvite from B leg');
    }
  }

  _onMaxCallDuration(cs) {
    this.logger.info(`Dial:_onMaxCallDuration tearing down call as it has reached ${this.timeLimit}s`);
    this.ep && this.ep.unbridge();
    this.kill(cs);
  }

  /**
   * We now have a call leg produced by the Dial action, so
   * - hangup any simrings in progress
   * - save the dialog and endpoint
   * - clock the start time of the call,
   * - start a max call length timer (optionally)
   * - start answering machine detection (optionally)
   * - launch any nested tasks
   * - and establish a handler to clean up if the called party hangs up
   */
  async _selectSingleDial(cs, sd) {
    debug(`Dial:_selectSingleDial ep for outbound call: ${sd.ep.uuid}`);
    this.dials.delete(sd.callSid);

    this.sd = sd;
    this.callSid = sd.callSid;
    if (this.earlyMedia) {
      debug('Dial:_selectSingleDial propagating answer supervision on A leg now that B is connected');
      await cs.propagateAnswer();
    }
    if (this.timeLimit) {
      this.timerMaxCallDuration = setTimeout(this._onMaxCallDuration.bind(this, cs), this.timeLimit * 1000);
    }
    sessionTracker.add(this.callSid, cs);
    this.dlg.on('destroy', () => {
      /* if our child is adulting, he's own his own now.. */
      if (this.dlg) {
        this.logger.debug('Dial:_selectSingleDial called party hungup, ending dial operation');
        sessionTracker.remove(this.callSid);
        if (this.timerMaxCallDuration) {
          clearTimeout(this.timerMaxCallDuration);
          this.timerMaxCallDuration = null;
        }
        this.ep && this.ep.unbridge();
        this.kill(cs);
      }
    });

    Object.assign(this.results, {
      dialCallStatus: CallStatus.Completed,
      dialSipStatus: 200,
      dialCallSid: sd.callSid,
    });

    if (this.dubTasks) {
      for (const dub of this.dubTasks) {
        try {
          await dub.exec(cs, {ep: sd.ep});
        }
        catch (err) {
          this.logger.error({err}, 'Dial:_selectSingleDial - error executing dubTask');
        }
      }
    }

    if (this.parentDtmfCollector) this._installDtmfDetection(cs, cs.dlg);
    if (this.childDtmfCollector) this._installDtmfDetection(cs, this.dlg);
    if (cs.sipRequestWithinDialogHook) this._initSipIndialogRequestListener(cs, this.dlg);

    if (this.transcribeTask) this.transcribeTask.exec(cs, {ep: this.epOther, ep2:this.ep});
    if (this.listenTask) this.listenTask.exec(cs, {ep: this.epOther});
    if (this.startAmd) {
      try {
        this.startAmd(cs, this.ep, this, this.data.amd);
      } catch (err) {
        this.logger.info({err}, 'Dial:_selectSingleDial - Error calling startAmd');
      }
    }

    /* boost audio signal if requested */
    if (this.boostAudioSignal) {
      try {
        const db = parseDecibels(this.boostAudioSignal);
        this.logger.info(`Dial: boosting audio signal by ${db} dB`);
        const args = [this.ep.uuid, 'setGain', db];
        await this.ep.api('uuid_dub', args);
      } catch (err) {
        this.logger.info({err}, 'Dial:_selectSingleDial - Error boosting audio signal');
      }
    }

    /* if we can release the media back to the SBC, do so now */
    if (this.canReleaseMedia || this.shouldExitMediaPathEntirely) {
      setTimeout(this._releaseMedia.bind(this, cs, sd, this.shouldExitMediaPathEntirely), 200);
    }
  }

  _bridgeEarlyMedia(sd) {
    if (this.epOther && !this.bridged) {
      this.epOther.api('uuid_break', this.epOther.uuid);
      this.logger.debug('Dial:_bridgeEarlyMedia: bridging early media');
      this.epOther.bridge(sd.ep);
      this.bridged = true;
    }
  }

  /* public api */
  async updateMediaPath(desiredPath) {
    this.logger.info(`Dial:updateMediaPath - ${this._mediaPath} => ${desiredPath}`);
    switch (desiredPath) {
      case MediaPath.NoMedia:
        assert(this._mediaPath !== MediaPath.NoMedia, 'updateMediaPath: already no-media');
        await this._releaseMedia(this.cs, this.sd, true);
        break;

      case MediaPath.PartialMedia:
        assert(this._mediaPath !== MediaPath.PartialMedia, 'updateMediaPath: already partial-media');
        if (this._mediaPath === MediaPath.FullMedia) {
          await this._releaseMedia(this.cs, this.sd, false);
        }
        else {
          // to go from no-media to partial-media we need to go through full-media first
          await this.reAnchorMedia(this.cs, this.sd);
          await this._releaseMedia(this.cs, this.sd, false);
        }
        assert(!this.epOther, 'updateMediaPath: epOther should be null');
        assert(!this.ep, 'updateMediaPath: ep should be null');

        break;
      case MediaPath.FullMedia:
        assert(this._mediaPath !== MediaPath.FullMedia, 'updateMediaPath: already full-media');
        await this.reAnchorMedia(this.cs, this.sd);
        break;

      default:
        assert(false, `updateMediaPath: invalid path request ${desiredPath}`);
    }
  }

  /**
   * Release the media from freeswitch
   * @param {*} cs
   * @param {*} sd
   */
  async _releaseMedia(cs, sd, releaseEntirely = false) {
    assert(cs.ep && sd.ep);

    try {
      // Wait until we got new SDP from B leg to ofter to A Leg
      const aLegSdp = cs.ep.remote.sdp;
      await sd.releaseMediaToSBC(aLegSdp, cs.ep.local.sdp, releaseEntirely);
      const bLegSdp = sd.dlg.remote.sdp;
      await cs.releaseMediaToSBC(bLegSdp, releaseEntirely);
      this.epOther = null;
      this._mediaPath = releaseEntirely ? MediaPath.NoMedia : MediaPath.PartialMedia;
      this.logger.info(
        `Dial:_releaseMedia - successfully released media from freewitch, media path is now ${this._mediaPath}`);
    } catch (err) {
      this.logger.info({err}, 'Dial:_releaseMedia error');
    }
  }

  async reAnchorMedia(cs, sd) {
    if (cs.ep && sd.ep) return;

    this.logger.info('Dial:reAnchorMedia - re-anchoring media to freewitch');
    await Promise.all([sd.reAnchorMedia(this._mediaPath), cs.reAnchorMedia(this._mediaPath)]);
    this.epOther = cs.ep;

    this.epOther.bridge(this.ep);

    this._mediaPath = MediaPath.FullMedia;
    this.logger.info(
      `Dial:_releaseMedia - successfully re-anchored media to freewitch, media path is now ${this._mediaPath}`);
  }

  // Handle RE-INVITE hold from caller leg.
  async handleReinviteAfterMediaReleased(req, res) {
    let isHandled = false;
    if (this.isOnHoldEnabled) {
      if (isOnhold(req.body)) {
        if (!this.epOther && !this.ep) {
          // update callee leg for new SDP from caller.
          const sdp = await this.dlg.modify(req.body);
          res.send(200, {body: sdp});
          // Onhold but media is already released, reconnect
          await this.reAnchorMedia(this.cs, this.sd);
          isHandled = true;
          this.isIncomingLegHold = true;
        }
        this._onHoldHook(req);
      } else if (!isOnhold(req.body)) {
        if (this.epOther && this.ep && this.isIncomingLegHold &&
          (this.canReleaseMedia || this.shouldExitMediaPathEntirely)) {
          // Offhold, time to release media
          const newSdp = await this.epOther.modify(req.body);
          await res.send(200, {body: newSdp});
          await this._releaseMedia(this.cs, this.sd, this.shouldExitMediaPathEntirely);
          isHandled = true;
        }
        this.isIncomingLegHold = false;
        if (this._onHoldSession) {
          this._onHoldSession.kill();
        }
      }
    }

    if (!isHandled) {
      const sdp = await this.dlg.modify(req.body);
      this.logger.info({sdp}, 'Dial:handleReinviteAfterMediaReleased - sent reinvite to B leg');
      res.send(200, {body: sdp});
    }
  }

  _onAmdEvent(cs, evt) {
    this.logger.info({evt}, 'Dial:_onAmdEvent');
    const {actionHook} = this.data.amd;
    this.performHook(cs, actionHook, evt)
      .catch((err) => {
        this.logger.error({err}, 'Dial:_onAmdEvent - error calling actionHook');
      });
  }

  async _onHoldHook(req, allowed = [TaskName.Play, TaskName.Say, TaskName.Pause]) {
    if (this.data.onHoldHook) {
      // send silence for keep Voice quality
      await this.epOther.play('silence_stream://500');
      let allowedTasks;
      do {
        try {
          const b3 = this.getTracingPropagation();
          const httpHeaders = b3 && {b3};
          const json = await this.cs.application.requestor.
            request('verb:hook', this.data.onHoldHook, {
              ...this.cs.callInfo.toJSON(),
              hold_detail: {
                from: req.get('From'),
                to: req.get('To')
              }
            }, httpHeaders);
          const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
          allowedTasks = tasks.filter((t) => allowed.includes(t.name));
          if (tasks.length !== allowedTasks.length) {
            this.logger.debug({tasks, allowedTasks}, 'unsupported task');
            throw new Error(`unsupported verb in enqueue waitHook: only ${JSON.stringify(allowed)}`);
          }
          this.logger.debug(`DialTask:_onHoldHook: executing ${tasks.length} tasks`);
          if (tasks.length) {
            this._onHoldSession = new ConfirmCallSession({
              logger: this.logger,
              application: this.cs.application,
              dlg: this.isIncomingLegHold ? this.dlg : this.cs.dlg,
              ep: this.isIncomingLegHold ? this.ep : this.cs.ep,
              callInfo: this.cs.callInfo,
              accountInfo: this.cs.accountInfo,
              tasks,
              rootSpan: this.cs.rootSpan
            });
            await this._onHoldSession.exec();
            this._onHoldSession = null;
          }
        } catch (error) {
          this.logger.info(error, 'DialTask:_onHoldHook: failed retrieving waitHook');
          this._onHoldSession = null;
          break;
        }
      } while (allowedTasks && allowedTasks.length > 0 && !this.killed && this.isOnHold);
      this.logger.info('Finish onHoldHook');
    }
  }
}

module.exports = TaskDial;
