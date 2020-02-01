const Task = require('./task');
const makeTask = require('./make_task');
const {CallStatus, CallDirection, TaskName, TaskPreconditions, MAX_SIMRINGS} = require('../utils/constants');
const assert = require('assert');
const placeCall = require('../utils/place-outdial');
const config = require('config');
const debug = require('debug')('jambonz:feature-server');

function compareTasks(t1, t2) {
  if (t1.type !== t2.type) return false;
  switch (t1.type) {
    case 'phone':
      return t1.number === t1.number;
    case 'user':
      return t2.name === t1.name;
    case 'sip':
      return t2.sipUri === t1.sipUri;
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
    this.confirmUrl = this.data.confirmUrl;
    this.confirmMethod = this.data.confirmMethod;

    if (this.data.listen) {
      this.listenTask = makeTask(logger, {'listen': this.data.listen});
    }
    if (this.data.transcribe) {
      this.transcribeTask = makeTask(logger, {'transcribe' : this.data.transcribe});
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
    super.exec(cs);
    try {
      if (cs.direction === CallDirection.Inbound) {
        await this._initializeInbound(cs);
      }
      await this._attemptCalls(cs);
      await this.awaitTaskDone();
      await this.performAction(this.method, null, this.results);
    } catch (err) {
      this.logger.error(`TaskDial:exec terminating with error ${err.message}`);
      this.kill();
    }
  }

  async kill() {
    super.kill();
    this._killOutdials();
    if (this.sd) {
      this.sd.kill();
      this.sd = null;
    }
    if (this.listenTask) await this.listenTask.kill();
    if (this.transcribeTask) await this.transcribeTask.kill();
    if (this.timerMaxCallDuration) clearTimeout(this.timerMaxCallDuration);
    this.notifyTaskDone();
  }

  _killOutdials() {
    for (const [callSid, sd] of Array.from(this.dials)) {
      this.logger.debug(`Dial:_killOutdials killing callSid ${callSid}`);
      sd.kill().catch((err) => this.logger.info(err, `Dial:_killOutdials Error killing ${callSid}`));
    }
    this.dials.clear();
  }

  async _initializeInbound(cs) {
    const {ep} = await cs.connectInboundCallToIvr(this.earlyMedia);
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

    const sbcAddress = cs.direction === CallDirection.Inbound ?
      `${req.source_address}:${req.source_port}` :
      config.get('sbcAddress');
    const opts = {
      headers: req && req.has('X-CID') ? Object.assign(this.headers, {'X-CID': req.get('X-CID')}) : this.headers,
      proxy: `sip:${sbcAddress}`,
      callingNumber: this.callerId || req.callingNumber
    };

    const ms = await cs.getMS();
    const timerRing = setTimeout(() => {
      this.logger.info(`Dial:_attemptCall: ring no answer timer ${this.timeout}s exceeded`);
      this._killOutdials();
    }, this.timeout * 1000);

    this.target.forEach((t) => {
      try {
        t.url = t.url || this.confirmUrl;
        t.method = t.method || this.confirmMethod || 'POST';
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
              this.kill();
            }
          })
          .on('callStatusChange', (obj) => {
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
                  this.kill();
                }
                break;
            }
            if (this.results.dialCallStatus !== CallStatus.Completed) {
              Object.assign(this.results, {
                dialCallStatus: obj.callStatus,
                dialCallSid: sd.callSid,
              });
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
              this.kill();
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
        this.kill();
      }, this.timeLimit * 1000);
    }
    this.dlg.on('destroy', () => {
      this.logger.debug('Dial:_selectSingleDial called party hungup, ending dial operation');
      if (this.timerMaxCallDuration) clearTimeout(this.timerMaxCallDuration);
      this.ep.unbridge();
      this.kill();
    });

    Object.assign(this.results, {
      dialCallStatus: CallStatus.Completed,
      dialCallSid: sd.callSid,
    });

    if (this.transcribeTask) this.transcribeTask.exec(cs, this.ep, this);
    if (this.listenTask) this.listenTask.exec(cs, this.ep, this);
  }

  _bridgeEarlyMedia(sd) {
    if (this.epOther && !this.bridged) {
      this.epOther.api('uuid_break', this.epOther.uuid);
      this.epOther.bridge(sd.ep);
      this.bridged = true;
    }
  }

}

module.exports = TaskDial;
