const Task = require('./task');
const Emitter = require('events');
const ConfirmCallSession = require('../session/confirm-call-session');
const { normalizeJambones } = require('@jambonz/verb-specifications');
const makeTask = require('./make_task');
const {TaskName, TaskPreconditions, QueueResults, KillReason} = require('../utils/constants');
const bent = require('bent');
const assert = require('assert');

const getUrl = (cs) => `${cs.srf.locals.serviceUrl}/v1/enqueue/${cs.callSid}`;

const getElapsedTime = (from) => Math.floor((Date.now() - from) / 1000);

class TaskEnqueue extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.logger = logger;
    this.preconditions = TaskPreconditions.Endpoint;

    this.queueName = this.data.name;
    this.waitHook = this.data.waitHook;

    this.emitter = new Emitter();
    this.state = QueueResults.Wait;

    // transferred from another server in order to bridge to a local caller?
    if (this.data._) {
      this.bridgeNow = true;
      this.bridgeDetails = {
        epUid: this.data._.epUuid,
        notifyUrl: this.data._.notifyUrl
      };
      this.waitStartTime = this.data._.waitStartTime;
      this.connectTime = this.data._.connectTime;
    }
  }

  get name() { return TaskName.Enqueue; }

  async exec(cs, {ep}) {
    await super.exec(cs);
    const dlg = cs.dlg;
    this.queueName = `queue:${cs.accountSid}:${this.queueName}`;

    try {
      if (!this.bridgeNow) {
        await this._addToQueue(cs, dlg, ep);
        await this._doWait(cs, dlg, ep);
      }
      else {
        // update dialog's answer time to when it was answered on the previous server, not now
        dlg.connectTime = this.connectTime;
        await this._doBridge(cs, dlg, ep);
      }
      if (!this.callMoved) await this.performAction();
      await this.awaitTaskDone();

      this.logger.debug(`TaskEnqueue:exec - task done queue ${this.queueName}`);
    } catch (err) {
      this.logger.info(err, `TaskEnqueue:exec - error in enqueue ${this.queueName}`);
    }
  }

  async kill(cs, reason) {
    super.kill(cs);
    this.killReason = reason || KillReason.Hangup;
    this.logger.info(`TaskEnqueue:kill ${this.queueName} with reason ${this.killReason}`);
    this.emitter.emit('kill', reason || KillReason.Hangup);
    this.notifyTaskDone();
  }

  async _addToQueue(cs, dlg) {
    const {pushBack} = cs.srf.locals.dbHelpers;
    const url = getUrl(cs);
    this.waitStartTime = Date.now();
    this.logger.debug({queue: this.queueName, url}, 'pushing url onto queue');
    const members = await pushBack(this.queueName, url);
    this.logger.info(`TaskEnqueue:_addToQueue: added to queue, length now ${members}`);
    this.notifyUrl = url;

    /* invoke account-level webhook for queue event notifications */
    try {
      cs.performQueueWebhook({
        event: 'join',
        queue: this.data.name,
        length: members,
        joinTime: this.waitStartTime
      });
    } catch (err) {}
  }

  async _removeFromQueue(cs) {
    const {removeFromList, lengthOfList} = cs.srf.locals.dbHelpers;
    await removeFromList(this.queueName, getUrl(cs));
    return await lengthOfList(this.queueName);
  }

  async performAction() {
    const params = {
      queueSid: this.queueName,
      queueTime: getElapsedTime(this.waitStartTime),
      queueResult: this.state
    };
    await super.performAction(params, this.killReason !== KillReason.Replaced);
  }

  /**
   * Add ourselves to the queue with a url that can be invoked to tell us to dequeue
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _doWait(cs, dlg, ep) {
    return new Promise(async(resolve, reject) => {
      this.emitter
        .once('dequeue', (opts) => {
          this.bridgeDetails = opts;
          this.logger.info({bridgeDetails: this.bridgeDetails}, `time to dequeue from ${this.queueName}`);
          if (this._playSession) {
            this._leave = false;
            this._playSession.kill();
            this._playSession = null;
          }
          resolve(this._doBridge(cs, dlg, ep));
        })
        .once('kill', async() => {

          /* invoke account-level webhook for queue event notifications */
          if (!this.dequeued) {
            try {
              const members = await this._removeFromQueue(cs);
              cs.performQueueWebhook({
                event: 'leave',
                queue: this.data.name,
                length: members,
                leaveReason: 'abandoned',
                leaveTime: Date.now()
              });
            } catch (err) {}
          }

          if (this._playSession) {
            this.logger.debug('killing waitUrl');
            this._playSession.kill();
            this._playSession = null;
          }
          resolve();
        });

      if (this.waitHook && !this.killed) {
        do {
          try {
            await ep.play('silence_stream://500');
            const tasks = await this._playHook(cs, dlg, this.waitHook);
            if (0 === tasks.length) break;
          } catch (err) {
            if (!this.bridgeDetails && !this.killed) {
              this.logger.info(err, `TaskEnqueue:_doWait: failed retrieving waitHook for ${this.queueName}`);
            }
            this._playSession = null;
            break;
          }
        } while (!this.killed && !this.bridgeDetails);
      }
    });

  }

  /**
   * Bridge to another call.
   * The call may be homed on this feature server, or another one -
   * in the latter case, move the call to the other server via REFER
   * Returns a promise that resolves:
   * (a) When the call is transferred to the other feature server if the dequeue-er is not local, or
   * (b) When either party hangs up the bridged call
   * @param {CallSession} cs
   * @param {SipDialog} dlg
   */
  async _doBridge(cs, dlg, ep) {
    assert(this.bridgeNow || this.bridgeDetails.dequeueSipAddress);
    if (!this.bridgeNow && cs.srf.locals.localSipAddress !== this.bridgeDetails.dequeueSipAddress) {
      this.logger.info({
        localServer: cs.srf.locals.localSipAddress,
        otherServer: this.bridgeDetails.dequeueSipAddress
      }, `TaskEnqueue:_doBridge: leg for queue ${this.queueName} is hosted elsewhere`);
      const success = await this.transferCallToFeatureServer(cs, this.bridgeDetails.dequeueSipAddress, {
        waitStartTime: this.waitStartTime,
        epUuid: this.bridgeDetails.epUuid,
        notifyUrl: this.bridgeDetails.notifyUrl,
        connectTime: dlg.connectTime.valueOf()
      });

      /**
       * If the REFER succeeded, we will get a BYE from the SBC
       * which will trigger kill and the end of the execution of the CallSession
       * which is what we want - so do nothing and let that happen.
       * If on the other hand, the REFER failed then we are in a bad state
       * and need to end the enqueue task with a failure indication and
       * allow the application to continue on
       */
      if (success) {
        this.logger.info(`TaskEnqueue:_doBridge: REFER of ${this.queueName} succeeded`);
        return;
      }
      this.state = QueueResults.Error;
      this.notifyTaskDone();
      return;
    }
    this.logger.info(`TaskEnqueue:_doBridge: queue ${this.queueName} is hosted locally`);
    await this._bridgeLocal(cs, dlg, ep);
    this.notifyTaskDone();
  }

  _bridgeLocal(cs, dlg, ep) {
    assert(this.bridgeDetails.notifyUrl);

    return new Promise(async(resolve, reject) => {
      try {

        // notify partner we are ready to be bridged - giving him our possibly new url and endpoint
        const notifyUrl = getUrl(cs);
        const url = this.bridgeDetails.notifyUrl;

        this.logger.debug('TaskEnqueue:_doBridge: ready to be bridged');
        bent('POST', 202)(url, {
          event: 'ready',
          epUuid: ep.uuid,
          notifyUrl
        }).catch((err) => {
          this.logger.info({err, url}, 'TaskEnqueue:_bridgeLocal error sending bridged event');
          /**
           * TODO: this probably means he dropped while we were connecting....
           * should we put this call back to the front of the queue so he gets serviced (?)
           */
          this.state = QueueResults.Error;
          reject(new Error('bridge failure'));
        });

        // resolve when either side hangs up
        this.state = QueueResults.Bridged;
        this.emitter
          .on('hangup', () => {
            this.logger.info('TaskEnqueue:_bridgeLocal ending with hangup from dequeue party');
            ep.unbridge().catch((err) => {});
            resolve();
          })
          .on('kill', (reason) => {
            this.killReason = reason;
            this.logger.info(`TaskEnqueue:_bridgeLocal ending with ${this.killReason}`);
            ep.unbridge().catch((err) => {});

            // notify partner that we dropped
            bent('POST', 202)(this.bridgeDetails.notifyUrl, {event: 'hangup'}).catch((err) => {
              this.logger.info(err, 'TaskEnqueue:_bridgeLocal error sending hangup event to partner');
            });
            resolve();
          });

      } catch (err) {
        this.state = QueueResults.Error;
        this.logger.error(err, 'TaskEnqueue:_bridgeLocal error');
        reject(err);
      }
    });
  }

  /**
   * We are being dequeued and bridged to another call.
   * It may be on this server or a different one, and we are
   * given instructions how to find it and connect.
   * @param {Object} opts
   * @param {string} opts.epUuid uuid of the endpoint we need to bridge to
   * @param {string} opts.dequeueSipAddress ip:port of the feature server hosting the other call
   */
  async notifyQueueEvent(cs, opts) {
    if (opts.event === 'dequeue') {
      if (this.bridgeNow) return;
      this.logger.info({opts}, `TaskEnqueue:notifyDequeueEvent: leaving ${this.queueName} because someone wants me`);
      assert(opts.dequeueSipAddress && opts.epUuid && opts.notifyUrl);
      this.emitter.emit('dequeue', opts);

      try {
        const {lengthOfList} = cs.srf.locals.dbHelpers;
        const members = await lengthOfList(this.queueName);
        this.dequeued = true;
        cs.performQueueWebhook({
          event: 'leave',
          queue: this.data.name,
          length: Math.max(members - 1, 0),
          leaveReason: 'dequeued',
          leaveTime: Date.now(),
          dequeuer: opts.dequeuer
        });
      } catch (err) {}
    }
    else if (opts.event === 'hangup') {
      this.emitter.emit('hangup');
    }
    else {
      this.logger.error({opts}, 'TaskEnqueue:notifyDequeueEvent - unsupported event/payload');
    }
  }

  async _playHook(cs, dlg, hook, allowed = [TaskName.Play, TaskName.Say, TaskName.Pause, TaskName.Leave]) {
    const {lengthOfList, getListPosition} = cs.srf.locals.dbHelpers;
    const b3 = this.getTracingPropagation();
    const httpHeaders = b3 && {b3};

    assert(!this._playSession);
    if (this.killed) return [];

    const params = {
      queueSid: this.queueName,
      queueTime: getElapsedTime(this.waitStartTime)
    };
    try {
      const queueSize = await lengthOfList(this.queueName);
      const queuePosition = await getListPosition(this.queueName, this.notifyUrl);
      Object.assign(params, {queueSize, queuePosition});
    } catch (err) {
      this.logger.error({err}, `TaskEnqueue:_playHook error retrieving list info for queue ${this.queueName}`);
    }
    const json = await cs.application.requestor.request('verb:hook', hook, params, httpHeaders);
    const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));

    const allowedTasks = tasks.filter((t) => allowed.includes(t.name));
    if (tasks.length !== allowedTasks.length) {
      this.logger.debug({tasks, allowedTasks}, 'unsupported task');
      throw new Error(`unsupported verb in enqueue waitHook: only ${JSON.stringify(allowed)}`);
    }
    this.logger.debug(`TaskEnqueue:_playHook: executing ${tasks.length} tasks`);

    // check for 'leave' verb and only execute tasks up till then
    const tasksToRun = [];
    for (const o of tasks) {
      if (o.name === TaskName.Leave) {
        this._leave = true;
        this.logger.info('waitHook returned a leave task');
        break;
      }
      tasksToRun.push(o);
    }
    const cloneTasks = [...tasksToRun];
    if (this.killed) return [];
    else if (tasksToRun.length > 0) {
      this._playSession = new ConfirmCallSession({
        logger: this.logger,
        application: cs.application,
        dlg,
        ep: cs.ep,
        callInfo: cs.callInfo,
        accountInfo: cs.accountInfo,
        tasks: tasksToRun,
        rootSpan: cs.rootSpan
      });
      await this._playSession.exec();
      this._playSession = null;
    }
    if (this._leave) {
      this.state = QueueResults.Leave;
      this.kill(cs);
    }
    return cloneTasks;
  }
}

module.exports = TaskEnqueue;
