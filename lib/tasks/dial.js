const Task = require('./task');
const makeTask = require('./make_task');
const {CallStatus, CallDirection, TaskName, TaskPreconditions, MAX_SIMRINGS} = require('../utils/constants');
const assert = require('assert');
const placeCall = require('../utils/place-outdial');
const sessionTracker = require('../session/session-tracker');
const DtmfCollector = require('../utils/dtmf-collector');
const debug = require('debug')('jambonz:feature-server');

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

class TaskDial extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.None;

    this.earlyMedia = this.data.answerOnBridge === true;
    this.callerId = this.data.callerId;
    this.dialMusic = this.data.dialMusic;
    this.headers = this.data.headers || {};
    this.method = this.data.method || 'POST';
    this.target = filterAndLimit(this.logger, this.data.target);
    this.timeout = this.data.timeout || 60;
    this.timeLimit = this.data.timeLimit;
    this.confirmHook = this.data.confirmHook;
    this.confirmMethod = this.data.confirmMethod;
    this.dtmfHook = this.data.dtmfHook;
    this.proxy = this.data.proxy;

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

    this.results = {};
    this.bridged = false;
    this.dials = new Map();
  }

  get dlg() {
    if (this.sd) return this.sd.dlg;
  }

  get ep() {
    if (this.sd) return this.sd.ep;
  }

  get name() { return TaskName.Dial; }

  async exec(cs) {
    await super.exec(cs);
    try {
      if (cs.direction === CallDirection.Inbound) {
        await this._initializeInbound(cs);
      }
      else {
        this.epOther = cs.ep;
        if (this.dialMusic && this.epOther && this.epOther.connected) {
          this.epOther.play(this.dialMusic).catch((err) => {});
        }
      }
      this._installDtmfDetection(cs, this.epOther, this.parentDtmfCollector);
      await this._attemptCalls(cs);
      await this.awaitTaskDone();
      await this.performAction(this.results);
      this._removeDtmfDetection(cs, this.epOther);
      this._removeDtmfDetection(cs, this.ep);
    } catch (err) {
      this.logger.error({err}, 'TaskDial:exec terminating with error');
      this.kill(cs);
    }
  }

  async kill(cs) {
    super.kill(cs);
    this._removeDtmfDetection(this.cs, this.epOther);
    this._removeDtmfDetection(this.cs, this.ep);
    this._killOutdials();
    if (this.sd) {
      this.sd.kill();
      this.sd = null;
    }
    if (this.callSid) sessionTracker.remove(this.callSid);
    if (this.listenTask) await this.listenTask.kill(cs);
    if (this.transcribeTask) await this.transcribeTask.kill(cs);
    if (this.timerMaxCallDuration) clearTimeout(this.timerMaxCallDuration);
    this.notifyTaskDone();
  }

  /**
   * whisper a prompt to one side of the call
   * @param {*} tasks - array of play/say tasks to execute
   */
  async whisper(tasks, callSid) {
    if (!this.epOther || !this.ep) return this.logger.info('Dial:whisper: no paired endpoint found');
    try {
      const cs = this.callSession;
      this.logger.debug('Dial:whisper unbridging endpoints');
      await this.epOther.unbridge();
      this.logger.debug('Dial:whisper executing tasks');
      while (tasks.length && !cs.callGone) {
        const task = tasks.shift();
        await task.exec(cs, callSid === this.callSid ? this.ep : this.epOther);
      }
      this.logger.debug('Dial:whisper tasks complete');
      if (!cs.callGone) this.epOther.bridge(this.ep);
    } catch (err) {
      this.logger.error(err, 'Dial:whisper error');
    }
  }

  /**
   * mute or unmute one side of the call
   */
  async mute(callSid, doMute) {
    if (!this.epOther || !this.ep) return this.logger.info('Dial:mute: no paired endpoint found');
    try {
      const parentCall = callSid !== this.callSid;
      const ep = parentCall ? this.epOther : this.ep;
      await ep[doMute ? 'mute' : 'unmute']();
      this.logger.debug(`Dial:mute ${doMute ? 'muted' : 'unmuted'} ${parentCall ? 'parentCall' : 'childCall'}`);
    } catch (err) {
      this.logger.error(err, 'Dial:mute error');
    }
  }

  _killOutdials() {
    for (const [callSid, sd] of Array.from(this.dials)) {
      this.logger.debug(`Dial:_killOutdials killing callSid ${callSid}`);
      sd.kill().catch((err) => this.logger.info(err, `Dial:_killOutdials Error killing ${callSid}`));
    }
    this.dials.clear();
  }

  _installDtmfDetection(cs, ep, dtmfDetector) {
    if (ep && this.dtmfHook && !ep.dtmfDetector) {
      ep.dtmfDetector = dtmfDetector;
      ep.on('dtmf', this._onDtmf.bind(this, cs, ep));
    }
  }
  _removeDtmfDetection(cs, ep) {
    if (ep) {
      delete ep.dtmfDetector;
      ep.removeAllListeners('dtmf');
    }
  }

  _onDtmf(cs, ep, evt) {
    if (ep.dtmfDetector) {
      const match = ep.dtmfDetector.keyPress(evt.dtmf);
      const requestor = ep.dtmfDetector === this.parentDtmfCollector ?
        cs.requestor :
        this.sd.requestor;
      if (match) {
        this.logger.debug(`parentCall triggered dtmf match: ${match}`);
        requestor.request(this.dtmfHook, Object.assign({dtmf: match}, cs.callInfo))
          .catch((err) => this.logger.info(err, 'Dial:_onDtmf - error'));
      }
    }
  }

  async _initializeInbound(cs) {
    const ep = await cs._evalEndpointPrecondition(this);
    this.epOther = ep;
    debug(`Dial:__initializeInbound allocated ep for incoming call: ${ep.uuid}`);

    if (this.dialMusic) {
      // play dial music to caller while we outdial
      ep.play(this.dialMusic).catch((err) => {
        this.logger.error(err, `TaskDial:_initializeInbound - error playing ${this.dialMusic}`);
      });
    }
  }

  async _attemptCalls(cs) {
    const {req, srf} = cs;
    const {getSBC} = srf.locals;
    const {lookupTeamsByAccount, lookupAccountBySid} = srf.locals.dbHelpers;
    const sbcAddress = this.proxy || getSBC();
    const teamsInfo = {};
    let fqdn;

    if (!sbcAddress) throw new Error('no SBC found for outbound call');
    const opts = {
      headers: req && req.has('X-CID') ? Object.assign(this.headers, {'X-CID': req.get('X-CID')}) : this.headers,
      proxy: `sip:${sbcAddress}`,
      callingNumber: this.callerId || req.callingNumber
    };
    Object.assign(opts.headers, {'X-Account-Sid': cs.accountSid});

    const t = this.target.find((t) => t.type === 'teams');
    if (t) {
      const obj = await lookupTeamsByAccount(cs.accountSid);
      if (!obj) throw new Error('dial to ms teams not allowed; account must first be configured with teams info');
      Object.assign(teamsInfo, {tenant_fqdn: t.tenant || obj.tenant_fqdn, ms_teams_fqdn: obj.ms_teams_fqdn});
    }

    const ms = await cs.getMS();
    const timerRing = setTimeout(() => {
      this.logger.info(`Dial:_attemptCall: ring no answer timer ${this.timeout}s exceeded`);
      this._killOutdials();
    }, this.timeout * 1000);

    this.target.forEach(async(t) => {
      try {
        t.url = t.url || this.confirmUrl;
        t.method = t.method || this.confirmMethod || 'POST';
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
        const sd = placeCall({
          logger: this.logger,
          application: cs.application,
          srf,
          ms,
          sbcAddress,
          target: t,
          opts,
          callInfo: cs.callInfo
        });
        this.dials.set(sd.callSid, sd);

        sd
          .on('callCreateFail', () => {
            this.dials.delete(sd.callSid);
            if (this.dials.size === 0 && !this.sd) {
              this.logger.debug('Dial:_attemptCalls - all calls failed after call create err, ending task');
              this.kill(cs);
            }
          })
          .on('callStatusChange', (obj) => {
            if (this.results.dialCallStatus !== CallStatus.Completed) {
              Object.assign(this.results, {
                dialCallStatus: obj.callStatus,
                dialCallSid: sd.callSid,
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
                clearTimeout(timerRing);
                break;
              case CallStatus.Failed:
              case CallStatus.Busy:
              case CallStatus.NoAnswer:
                this.dials.delete(sd.callSid);
                if (this.dials.size === 0 && !this.sd) {
                  this.logger.debug('Dial:_attemptCalls - all calls failed after call failure, ending task');
                  clearTimeout(timerRing);
                  this.kill(cs);
                }
                break;
            }
          })
          .on('accept', () => {
            this.logger.debug(`Dial:_attemptCalls - we have a winner: ${sd.callSid}`);
            this._connectSingleDial(cs, sd);
          })
          .on('decline', () => {
            this.logger.debug(`Dial:_attemptCalls - declined: ${sd.callSid}`);
            this.dials.delete(sd.callSid);
            if (this.dials.size === 0 && !this.sd) {
              this.logger.debug('Dial:_attemptCalls - all calls failed after decline, ending task');
              this.kill(cs);
            }
          });
      } catch (err) {
        this.logger.error(err, 'Dial:_attemptCalls');
      }
    });
  }

  _connectSingleDial(cs, sd) {
    if (!this.bridged) {
      this.logger.debug('Dial:_connectSingleDial bridging endpoints');
      this.epOther.api('uuid_break', this.epOther.uuid);
      this.epOther.bridge(sd.ep);
      this.bridged = true;
    }

    // ding! ding! ding! we have a winner
    this._selectSingleDial(cs, sd);
    this._killOutdials();       // NB: order is important
  }

  /**
   * We now have a call leg produced by the Dial action, so
   * - hangup any simrings in progress
   * - save the dialog and endpoint
   * - clock the start time of the call,
   * - start a max call length timer (optionally)
   * - launch any nested tasks
   * - and establish a handler to clean up if the called party hangs up
   */
  _selectSingleDial(cs, sd) {
    debug(`Dial:_selectSingleDial ep for outbound call: ${sd.ep.uuid}`);
    this.dials.delete(sd.callSid);

    this.sd = sd;
    this.callSid = sd.callSid;
    if (this.earlyMedia) {
      debug('Dial:_selectSingleDial propagating answer supervision on A leg now that B is connected');
      cs.propagateAnswer();
    }
    if (this.timeLimit) {
      this.timerMaxCallDuration = setTimeout(() => {
        this.logger.info(`Dial:_selectSingleDial tearing down call as it has reached ${this.timeLimit}s`);
        this.ep.unbridge();
        this.kill(cs);
      }, this.timeLimit * 1000);
    }
    sessionTracker.add(this.callSid, cs);
    this.dlg.on('destroy', () => {
      this.logger.debug('Dial:_selectSingleDial called party hungup, ending dial operation');
      sessionTracker.remove(this.callSid);
      if (this.timerMaxCallDuration) clearTimeout(this.timerMaxCallDuration);
      this.ep.unbridge();
      this.kill(cs);
    });

    Object.assign(this.results, {
      dialCallStatus: CallStatus.Completed,
      dialCallSid: sd.callSid,
    });

    if (this.childDtmfCollector) this._installDtmfDetection(cs, this.ep, this.childDtmfCollector);

    if (this.transcribeTask) this.transcribeTask.exec(cs, this.ep);
    if (this.listenTask) this.listenTask.exec(cs, this.ep);
  }

  _bridgeEarlyMedia(sd) {
    if (this.epOther && !this.bridged) {
      this.epOther.api('uuid_break', this.epOther.uuid);
      this.logger.debug('Dial:_bridgeEarlyMedia: bridging early media');
      this.epOther.bridge(sd.ep);
      this.bridged = true;
    }
  }

}

module.exports = TaskDial;
