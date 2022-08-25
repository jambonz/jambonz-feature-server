const Task = require('./task');
const Emitter = require('events');
const ConfirmCallSession = require('../session/confirm-call-session');
const {TaskName, TaskPreconditions, BONG_TONE} = require('../utils/constants');
const normalizeJambones = require('../utils/normalize-jambones');
const makeTask = require('./make_task');
const bent = require('bent');
const assert = require('assert');
const WAIT = 'wait';
const JOIN = 'join';
const START = 'start';


function confNoMatch(str) {
  return str.match(/^No active conferences/) || str.match(/Conference.*not found/);
}
function getWaitListName(confName) {
  return `${confName}:waitlist`;
}

function camelize(str) {
  return str.replace(/(?:^\w|[A-Z]|\b\w)/g, function(word, index) {
    return index === 0 ? word.toLowerCase() : word.toUpperCase();
  })
    .replace(/\s+/g, '')
    .replace(/-/g, '');
}

function unhandled(logger, cs, evt) {
  this.participantCount = parseInt(evt.getHeader('Conference-Size'));
  // logger.debug({evt}, `unhandled conference event: ${evt.getHeader('Action')}`) ;
  logger.debug(`unhandled conference event: ${evt.getHeader('Action')}`) ;
}

function capitalize(s) {
  if (typeof s !== 'string') return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

class Conference extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.logger = logger;
    this.preconditions = TaskPreconditions.Endpoint;

    if (!this.data.name) throw new Error('conference name required');

    this.confName = this.data.name;
    [
      'beep', 'startConferenceOnEnter', 'endConferenceOnExit', 'joinMuted',
      'maxParticipants', 'waitHook', 'statusHook', 'endHook', 'enterHook'
    ].forEach((attr) => this[attr] = this.data[attr]);
    this.record = this.data.record || {};
    this.statusEvents = [];
    if (this.statusHook) {
      ['start', 'end', 'join', 'leave', 'start-talking', 'stop-talking'].forEach((e) => {
        if ((this.data.statusEvents || []).includes(e)) this.statusEvents.push(e);
      });
    }

    this.emitter = new Emitter();
    this.results = {};

    // transferred from another server in order to bridge to a local caller?
    if (this.data._ && this.data._.connectTime) {
      this.connectTime = this.data._.connectTime;
    }
  }

  get name() { return TaskName.Conference; }

  get shouldRecord() { return this.record.path; }
  get isRecording() { return this.recordingInProgress; }

  async exec(cs, {ep}) {
    await super.exec(cs);
    this.ep = ep;
    const dlg = cs.dlg;

    // reset answer time if we were transferred from another feature server
    if (this.connectTime) dlg.connectTime = this.connectTime;


    this.ep.on('destroy', this._kicked.bind(this, cs, dlg));

    try {
      await this._init(cs, dlg);
      switch (this.action) {
        case JOIN:
          await this._doJoin(cs, dlg);
          break;
        case WAIT:
          await this._doWait(cs, dlg);
          break;
        case START:
          await this._doStart(cs, dlg);
          break;
      }
      await this.awaitTaskDone();

      this.logger.debug(`Conference:exec - conference ${this.confName} is over`);
      if (this.callMoved !== false) await this.performAction(this.results);
    } catch (err) {
      this.logger.info(err, `TaskConference:exec - error in conference ${this.confName}`);
    }
  }

  async kill(cs) {
    super.kill(cs);
    this.logger.info(`Conference:kill ${this.confName}`);
    this.emitter.emit('kill');
    await this._doFinalMemberCheck(cs);
    if (this.ep && this.ep.connected) this.ep.conn.removeAllListeners('esl::event::CUSTOM::*') ;
    this.notifyTaskDone();
  }

  /**
   * Determine which of three states we are in:
   * (1) Conference already exists -- we should JOIN
   * (2) Conference does not exist, and we should START it
   * (3) Conference does not exist, and we must WAIT for moderator
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _init(cs, dlg) {
    const friendlyName = this.confName;
    const {createHash, retrieveHash} = cs.srf.locals.dbHelpers;
    this.confName = `conf:${cs.accountSid}:${this.confName}`;

    this.statusParams = Object.assign({
      conferenceSid: this.confName,
      friendlyName
    }, cs.callInfo);

    // check if conference is in progress
    const obj = await retrieveHash(this.confName);
    if (obj) {
      this.logger.info({obj}, `Conference:_init conference ${this.confName} is already started`);
      this.joinDetails = { conferenceSipAddress: obj.sipAddress};
      this.conferenceStartTime = new Date(parseInt(obj.startTime));
      this.statusEvents = obj.statusEvents ? JSON.parse(obj.statusEvents) : [];
      this.statusHook = obj.statusHook ? JSON.parse(obj.statusHook) : null;
      this.action = JOIN;
    }
    else {
      if (this.startConferenceOnEnter === false) {
        this.logger.info(`Conference:_init conference ${this.confName} does not exist, wait for moderator`);
        this.action = WAIT;
      }
      else {
        this.logger.info(`Conference:_init conference ${this.confName} does not exist, provision it now..`);
        const obj = {
          sipAddress: cs.srf.locals.localSipAddress,
          startTime: Date.now()
        };
        if (this.statusEvents.length > 0 && this.statusHook) {
          Object.assign(obj, {
            statusEvents: JSON.stringify(this.statusEvents),
            statusHook: JSON.stringify(this._normalizeHook(cs, this.statusHook))
          });
        }
        const added = await createHash(this.confName, obj);
        if (added) {
          this.logger.info(`Conference:_init conference ${this.confName} successfully provisioned`);
          this.conferenceStartTime = new Date(obj.startTime);
          this.action = START;
        }
        else {
          this.logger.info(`Conference:_init conference ${this.confName} provision failed..someone beat me to it?`);
          const obj = await retrieveHash(this.confName);
          if (null === obj) {
            this.logger.error(`Conference:_init conference ${this.confName} provision failed again...exiting`);
            throw new Error('Failed to join conference');
          }
          this.joinDetails = { conferenceSipAddress: obj.sipAddress};
          this.conferenceStartTime = new Date(obj.startTime);
          this.statusEvents = obj.statusEvents ? JSON.parse(obj.statusEvents) : [];
          this.statusHook = obj.statusHook ? JSON.parse(obj.statusHook) : null;
          this.action = JOIN;
        }
      }
    }
  }

  /**
   * Wait for entry to a conference, which means
   * - add ourselves to the waiting list for the conference,
   * - if provided, continually invoke waitHook to play or say something (pause allowed as well)
   * - wait for an event indicating the conference has started (or caller hangs up).
   *
   * Returns a Promise that is resolved when:
   * a. caller hangs up while waiting, or
   * b. conference starts, participant joins the conference
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _doWait(cs, dlg) {
    await this._addToWaitList(cs);

    return new Promise(async(resolve, reject) => {
      this.emitter
        .once('join', (opts) => {
          this.joinDetails = opts;
          this.logger.info({opts}, `time to join conference ${this.confName}`);
          if (this._playSession) {
            this._playSession.kill();
            this._playSession = null;
          }

          // return a Promise that resolves at the end of the conference for this caller
          this.emitter.removeAllListeners();
          resolve(this._doJoin(cs, dlg));
        })
        .once('kill', () => {
          this._removeFromWaitList(cs);
          if (this._playSession) {
            this.logger.debug('killing waitUrl');
            this._playSession.kill();
            this._playSession = null;
          }
          cs.clearConferenceDetails();
          resolve();
        });

      if (this.waitHook) {
        do {
          try {
            await this.ep.play('silence_stream://750');
            const tasks = await this._playHook(cs, dlg, this.waitHook);
            if (0 === tasks.length) break;
          } catch (err) {
            if (!this.joinDetails && !this.killed) {
              this.logger.info(err, `Conference:_doWait: failed retrieving waitHook for ${this.confName}`);
            }
            this._playSession = null;
            break;
          }
        } while (!this.killed && !this.joinDetails);
      }
    });
  }

  /**
   * Join a conference that has already been started.
   * The conference may be homed on this feature server, or another one -
   * in the latter case, move the call to the other server via REFER
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _doJoin(cs, dlg) {
    assert(this.joinDetails.conferenceSipAddress);
    if (cs.srf.locals.localSipAddress !== this.joinDetails.conferenceSipAddress  && !cs.isTransferredCall) {
      this.logger.info({
        localServer: cs.srf.locals.localSipAddress,
        confServer: this.joinDetails.conferenceSipAddress
      }, `Conference:_doJoin: conference ${this.confName} is hosted elsewhere`);
      const success = await this.transferCallToFeatureServer(cs, this.joinDetails.conferenceSipAddress, {
        connectTime: dlg.connectTime.valueOf()
      });

      /**
       * If the REFER succeeded, we will get a BYE from the SBC
       * which will trigger kill and the end of the execution of the CallSession
       * which is what we want - so do nothing and let that happen.
       * If on the other hand, the REFER failed then we are in a bad state
       * and need to end the conference task with a failure indication and
       * allow the application to continue on
       */
      if (success) {
        this.logger.info(`Conference:_doJoin: REFER of ${this.confName} succeeded`);
        return;
      }
      this.notifyTaskDone();
      return;
    }
    this.logger.info(`Conference:_doJoin: conference ${this.confName} is hosted locally`);
    await this._joinConference(cs, dlg, false);
  }

  /**
   * Start a conference and notify anyone on the waiting list
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _doStart(cs, dlg) {
    await this._joinConference(cs, dlg, true);

    // notify waiting list members
    try {
      const {retrieveSet, deleteKey} = cs.srf.locals.dbHelpers;
      const setName = getWaitListName(this.confName);
      const members = await retrieveSet(setName);
      if (Array.isArray(members) && members.length > 0) {
        this.logger.info({members}, `Conference:doStart - notifying waiting list for ${this.confName}`);
        for (const url of members) {
          try {
            await bent('POST', 202)(url, {event: 'start', conferenceSipAddress: cs.srf.locals.localSipAddress});
          } catch (err) {
            this.logger.info(err, `Failed notifying ${url} to join ${this.confName}`);
          }
        }
        // now clear the waiting list
        deleteKey(setName);
      }
    } catch (err) {
      this.logger.error(err, 'Conference:_doStart - error notifying wait list');
    }
  }

  async _joinConference(cs, dlg, startConf) {
    if (startConf) {
      // conference should not exist - check but continue in either case
      const result = await cs.getMS().api(`conference ${this.confName} list count`);
      const notFound = typeof result === 'string' && confNoMatch(result);
      if (!notFound) {
        this.logger.info({result},
          `Conference:_joinConference: asked to start ${this.confName} but it unexpectedly exists`);
      }
      else {
        this.participantCount = 0;
      }
      this._notifyConferenceEvent(cs, 'start');
    }

    if (this.enterHook) {
      try {
        await this._playHook(cs, dlg, this.enterHook);
        if (!dlg.connected) {
          this.logger.debug('Conference:_doJoin: caller hung up during entry prompt');
          return;
        }
      } catch (err) {
        this.logger.error(err, `Error playing enterHook to caller for conference ${this.confName}`);
      }
    }

    const opts = {};
    if (this.endConferenceOnExit) Object.assign(opts, {flags: {endconf: true}});
    if (this.startConferenceOnEnter) Object.assign(opts, {flags: {moderator: true}});
    if (this.joinMuted) Object.assign(opts, {flags: {mute: true}});

    try {
      const {memberId, confUuid} = await this.ep.join(this.confName, opts);
      this.logger.debug({memberId, confUuid}, `Conference:_joinConference: successfully joined ${this.confName}`);
      this.memberId = memberId;
      this.confUuid = confUuid;

      cs.setConferenceDetails(memberId, this.confName, confUuid);
      const response = await this.ep.api('conference', [this.confName, 'get', 'count']);
      if (response.body && /\d+/.test(response.body)) this.participantCount = parseInt(response.body);
      this._notifyConferenceEvent(cs, 'join');

      // start recording if requested and we just started the conference
      if (startConf && this.shouldRecord) {
        this.logger.info(`recording conference to ${this.record.path}`);
        try {
          await this.ep.api(`conference ${this.confName} record ${this.record.path}`);
        } catch (err) {
          this.logger.info({err}, 'Conference:_joinConference - failed to start recording');
        }
      }

      // listen for conference events
      this.ep.filter('Conference-Unique-ID', this.confUuid);
      this.ep.conn.on('esl::event::CUSTOM::*', this.__onConferenceEvent.bind(this, cs)) ;

      // optionally play beep to conference on entry
      if (this.beep === true) {
        this.ep.api('conference',
          [this.confName, 'play', BONG_TONE])
          .catch((err) => {});
      }

    } catch (err) {
      this.logger.error(err, `Failed to join conference ${this.confName}`);
      throw err;
    }

    if (typeof this.maxParticipants === 'number' && this.maxParticipants > 1) {
      this.ep.api('conference', `${this.confName} set max_members ${this.maxParticipants}`)
        .catch((err) => this.logger.error(err, `Error setting max participants to ${this.maxParticipants}`));
    }
  }

  /**
   * The conference we have been waiting for has started.
   * It may be on this server or a different one, and we are
   * given instructions how to find it and connect.
   * @param {Object} opts
   * @param {string} opts.confName name of the conference
   * @param {string} opts.conferenceSipAddress ip:port of the feature server hosting the conference
   */
  notifyStartConference(cs, opts) {
    this.logger.info({opts}, `Conference:notifyStartConference: conference ${this.confName} has now started`);
    this.conferenceStartTime = new Date();
    this.emitter.emit('join', opts);
  }

  async doConferenceMuteNonModerators(cs, opts) {
    const mute = opts.conf_mute_status === 'mute';
    assert (cs.isInConference);

    this.logger.info(`Conference:doConferenceMuteNonModerators ${mute ? 'muting' : 'unmuting'} non-moderators`);
    this.ep.api(`conference ${this.confName} ${mute ? 'mute' : 'unmute'} non_moderator`)
      .catch((err) => this.logger.info({err}, 'Error muting or unmuting non_moderators'));

    if (this.conf_hold_status !== 'hold' && this._playSession) {
      this._playSession.kill();
      this._playSession = null;
    }
  }

  async doConferenceHold(cs, opts) {
    assert (cs.isInConference);

    const {conf_hold_status, wait_hook} = opts;
    let hookOnly = true;

    if (this.conf_hold_status !== conf_hold_status) {
      hookOnly = false;
      this.conf_hold_status = conf_hold_status;
      const hold = conf_hold_status === 'hold';

      this.ep.api(`conference ${this.confName} ${hold ? 'mute' : 'unmute'} ${this.memberId}`)
        .catch((err) => this.logger.info({err}, 'Error muting or unmuting participant'));
      this.ep.api(`conference ${this.confName} ${hold ? 'deaf' : 'undeaf'} ${this.memberId}`)
        .catch((err) => this.logger.info({err}, 'Error deafing or undeafing participant'));
    }

    if (hookOnly && this._playSession) {
      this._playSession.kill();
      this._playSession = null;
    }
    if (wait_hook && this.conf_hold_status === 'hold') {
      const {dlg} = cs;
      this._doWaitHookWhileOnHold(cs, dlg, wait_hook);
    }
    else if (this.conf_hold_status !== 'hold' && this._playSession) {
      this._playSession.kill();
      this._playSession = null;
    }
  }

  async _doWaitHookWhileOnHold(cs, dlg, wait_hook) {
    do {
      try {
        const tasks = await this._playHook(cs, dlg, wait_hook);
        if (0 === tasks.length) break;
      } catch (err) {
        if (!this.killed) {
          this.logger.info(err, `Conference:_doWait: failed retrieving wait_hook for ${this.confName}`);
        }
        this._playSession = null;
        break;
      }
    } while (!this.killed && this.conf_hold_status === 'hold');
  }

  /**
   * Add ourselves to the waitlist of sessions to be notified once
   * the conference starts
   * @param {CallSession} cs
   */
  async _addToWaitList(cs) {
    const {addToSet} = cs.srf.locals.dbHelpers;
    const setName = getWaitListName(this.confName);
    const url = `${cs.srf.locals.serviceUrl}/v1/conference/${cs.callSid}`;
    const added = await addToSet(setName, url);
    if (added !== 1) throw new Error(`failed adding to the waitlist for conference ${this.confName}: ${added}`);
    this.logger.debug(`successfully added to the waiting list for conference ${this.confName}`);
  }

  async _removeFromWaitList(cs) {
    const {removeFromSet} = cs.srf.locals.dbHelpers;
    const setName = getWaitListName(this.confName);
    const url = `${cs.srf.locals.serviceUrl}/v1/conference/${cs.callSid}`;
    try {
      const count = await removeFromSet(setName, url);
      this.logger.debug(`Conference:_removeFromWaitList removed ${count} from waiting list`);
    } catch (err) {
      this.logger.info(err, 'Error removing from waiting list');
    }
  }

  _normalizeHook(cs, hook) {
    if (typeof hook === 'object') return hook;
    const url = hook.startsWith('/') ?
      `${cs.application.requestor.baseUrl}${hook}` :
      hook;

    return { url } ;
  }

  /**
   * If we are the last one leaving the conference - turn out the lights.
   * Remove the conference info from the realtime database.
   * @param {*} cs
   */
  async _doFinalMemberCheck(cs) {
    if (!this.memberId) return; // never actually joined

    this.logger.debug(`Conference:_doFinalMemberCheck leaving ${this.confName} member count: ${this.participantCount}`);
    try {
      const response = await this.ep.api('conference', [this.confName, 'get', 'count']);
      if (response.body && confNoMatch(response.body)) this.participantCount = 0;
      else if (response.body && /^\d+$/.test(response.body)) this.participantCount = parseInt(response.body) - 1;
      this.logger.debug({response}, `Conference:_doFinalMemberCheck conference count ${this.participantCount}`);
    } catch (err) {
      this.logger.info({err}, 'Conference:_doFinalMemberCheck error retrieving count (we were probably kicked');
    }
    await this._notifyConferenceEvent(cs, 'leave');

    /**
     * when we hang up as the last member, the current member count = 1
     * when we are kicked out of the call when the moderator leaves, the member count = 0
     */
    if (this.participantCount === 0) {
      const {deleteKey} = cs.srf.locals.dbHelpers;
      try {
        this._notifyConferenceEvent(cs, 'end');
        const removed = await deleteKey(this.confName);
        this.logger.info(`conf ${this.confName} deprovisioned: ${removed ? 'success' : 'failure'}`);
      }
      catch (err) {
        this.logger.error(err, `Error deprovisioning conference ${this.confName}`);
      }
    }
  }

  async _playHook(cs, dlg, hook, allowed = [TaskName.Play, TaskName.Say, TaskName.Pause]) {
    assert(!this._playSession);
    const b3 = this.getTracingPropagation();
    const httpHeaders = b3 && {b3};
    const json = await cs.application.requestor.request('verb:hook', hook, cs.callInfo, httpHeaders);
    const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));

    const allowedTasks = tasks.filter((t) => allowed.includes(t.name));
    if (tasks.length !== allowedTasks.length) {
      this.logger.debug({tasks, allowedTasks}, 'unsupported task');
      throw new Error(`unsupported verb in conference waitHook: only ${JSON.stringify(allowed)}`);
    }
    this.logger.debug(`Conference:_playHook: executing ${tasks.length} tasks`);

    /* we might have been killed while off fetching waitHook */
    if (this.killed) return [];

    if (tasks.length > 0) {
      this._playSession = new ConfirmCallSession({
        logger: this.logger,
        application: cs.application,
        dlg,
        ep: cs.ep,
        callInfo: cs.callInfo,
        accountInfo: cs.accountInfo,
        memberId: this.memberId,
        confName: this.confName,
        tasks,
        rootSpan: cs.rootSpan
      });
      await this._playSession.exec();
      this._playSession = null;
    }
    return json;
  }

  /**
   * This event triggered when we are bounced from conference when moderator leaves.
   * Get a new endpoint up and running in case the app wants to go on (e.g post-call survey)
   * @param {*} cs CallSession
   * @param {*} dlg SipDialog
   */
  _kicked(cs, dlg) {
    this.logger.info(`Conference:kicked - I was dropped from conference ${this.confName}, task is complete`);
    this.replaceEndpointAndEnd(cs);
  }

  async replaceEndpointAndEnd(cs) {
    cs.clearConferenceDetails();
    if (this.replaced) return;
    this.replaced = true;
    try {
      this.ep = await cs.replaceEndpoint();
    } catch (err) {
      this.logger.error(err, 'Conference:replaceEndpointAndEnd failed');
    }
    this.kill(cs);
  }

  _notifyConferenceEvent(cs, eventName, params = {}) {
    if (this.statusEvents.includes(eventName)) {
      const b3 = this.getTracingPropagation();
      const httpHeaders = b3 && {b3};
      params.event = eventName;
      params.duration = (Date.now() - this.conferenceStartTime.getTime()) / 1000;
      if (!params.time) params.time = (new Date()).toISOString();
      if (!params.members && typeof this.participantCount === 'number') params.members = this.participantCount;
      cs.application.requestor
        .request('verb:hook', this.statusHook, Object.assign(params, this.statusParams, httpHeaders))
        .catch((err) => this.logger.info(err, 'Conference:notifyConferenceEvent - error'));
    }
  }

  __onConferenceEvent(cs, evt) {
    const eventName = evt.getHeader('Event-Subclass') ;
    if (eventName === 'conference::maintenance') {
      const action = evt.getHeader('Action') ;

      //invoke a handler for this action, if we have defined one
      const functionName = `_on${capitalize(camelize(action))}`;
      (Conference.prototype[functionName] || unhandled).bind(this, this.logger, cs, evt)() ;
    }
  }

  // conference event handlers
  _onDelMember(logger, cs, evt) {
    const memberId = parseInt(evt.getHeader('Member-ID')) ;
    this.participantCount = parseInt(evt.getHeader('Conference-Size'));
    if (memberId === this.memberId) {
      this.logger.info(`Conference:_onDelMember - I was dropped from conference ${this.confName}, task is complete`);
      this.replaceEndpointAndEnd(cs);
    }
  }

  _onStartTalking(logger, cs, evt) {
    const memberId = parseInt(evt.getHeader('Member-ID')) ;
    const size = this.participantCount = parseInt(evt.getHeader('Conference-Size'));
    if (memberId === this.memberId) {
      const time = new Date(evt.getHeader('Event-Date-Timestamp') / 1000).toISOString();
      this._notifyConferenceEvent(cs, 'start-talking', {
        time,
        members: size
      });
    }
  }

  _onStopTalking(logger, cs, evt) {
    const memberId = parseInt(evt.getHeader('Member-ID')) ;
    const size = this.participantCount = parseInt(evt.getHeader('Conference-Size'));
    if (memberId === this.memberId) {
      const time = new Date(evt.getHeader('Event-Date-Timestamp') / 1000).toISOString();
      this._notifyConferenceEvent(cs, 'stop-talking', {
        time,
        members: size
      });
    }
  }

}

module.exports = Conference;
