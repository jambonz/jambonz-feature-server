const Task = require('./task');
const name = 'dial';
const makeTask = require('./make_task');
const assert = require('assert');

class TaskDial extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.name = name;
    this.headers = this.data.headers || {};
    this.answerOnBridge = opts.answerOnBridge === true;
    this.timeout = opts.timeout || 60;
    this.method = opts.method || 'GET';
    this.dialMusic = opts.dialMusic;
    this.timeLimit = opts.timeLimit;
    this.strategy = opts.strategy || 'hunt';
    this.target = opts.target;
    this.canceled = false;
    this.finished = false;
    this.localResources = {};

    if (opts.transcribe) {
      this.transcribeTask = makeTask(logger, {'transcribe': opts.transcribe});
    }
    if (opts.listen) {
      this.listenTask = makeTask(logger, {'listen': opts.transcribe});
    }
  }

  static get name() { return name; }

  /**
   * Reject an incoming call attempt with a provided status code and (optionally) reason
   */
  async exec(cs) {
    try {
      await this._initializeInbound(cs);
      //await connectCall(cs);
      await this._untilCallEnds(cs);
    } catch (err) {
      this.logger.info(`TaskDial:exec terminating with error ${err.message}`);
    }

    return true;
  }

  async _initializeInbound(cs) {
    const {req, res} = cs;

    // the caller could hangup in the middle of all this..
    req.on('cancel', this._onCancel.bind(this, cs));

    try {
      const {ep} = await cs.createOrRetrieveEpAndMs(req.body);

      // caller might have hung up while we were doing that
      if (this.canceled) throw new Error('caller hung up');

      // check if inbound leg has already been answered
      let uas = cs.getResource('dlgIn');

      if (!uas) {
        // if answerOnBridge send a 183 (early media), otherwise go ahead and answer the call
        if (this.answerOnBridge && !req.finalResponseSent) {
          if (!this.dialMusic) res.send(180);
          else {
            res.send(183, {body: ep.remote.sdp});
          }
        }
        else {
          uas = await cs.srf.createUAS(req, res, {localSdp: ep.local.sdp});
          cs.addResource('dlgIn', uas);
          uas.on('destroy', this._onCallerHangup.bind(this, cs, uas));
        }
        cs.emit('callStatusChange', {status: 'ringing'});
      }

      // play dial music to caller, if provided
      if (this.dialMusic) {
        ep.play(this.dialMusic, (err) => {
          if (err) this.logger.error(err, `TaskDial:_initializeInbound - error playing ${this.dialMusic}`);
        });
      }
    } catch (err) {
      this.logger.error(err, 'TaskDial:_initializeInbound error');
      this.finished = true;
      if (!res.finalResponseSent && !this.canceled) res.send(500);
      this._clearResources(cs);
      throw err;
    }
  }

  _clearResources(cs) {
    for (const key in this.localResources) {
      this.localResources[key].destroy();
    }
    this.localResources = {};
  }

  _onCancel(cs) {
    this.logger.info('TaskDial: caller hung up before connecting');
    this.canceled = this.finished = true;
    this._clearResources();
    cs.emit('callStatusChange', {status: 'canceled'});
  }

  _onCallerHangup(cs, dlg) {
    cs.emit('callStatusChange', {status: 'canceled'});
    this.finished = true;
    this._clearResources();
  }

  /**
   * returns a Promise that resolves when the call ends
   */
  _untilCallEnds(cs) {
    const {res} = cs;

    return new Promise((resolve) => {
      assert(!this.finished);

      //TMP - hang up in 5 secs
      setTimeout(() => {
        res.send(480);
        this._clearResources();
        resolve();
      }, 5000);
      //TMP

      /*
      const dlgOut = this.localResources.dlgOut;
      assert(dlgIn.connected && dlgOut.connected);

      [this.dlgIn, this.dlgOut].forEach((dlg) => {
        dlg.on('destroy', () => resolve());
      });
      */
    });
  }
}

module.exports = TaskDial;
