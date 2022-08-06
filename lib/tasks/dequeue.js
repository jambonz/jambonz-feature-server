const Task = require('./task');
const {TaskName, TaskPreconditions, DequeueResults, BONG_TONE} = require('../utils/constants');
const Emitter = require('events');
const bent = require('bent');
const assert = require('assert');

const sleepFor = (ms) => new Promise((resolve) => setTimeout(() => resolve(), ms));

const getUrl = (cs) => `${cs.srf.locals.serviceUrl}/v1/dequeue/${cs.callSid}`;

class TaskDequeue extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.queueName = this.data.name;
    this.timeout = this.data.timeout || 0;
    this.beep = this.data.beep === true;

    this.emitter = new Emitter();
    this.state = DequeueResults.Timeout;
  }

  get name() { return TaskName.Dequeue; }

  async exec(cs, {ep}) {
    await super.exec(cs);
    this.ep = ep;
    this.queueName = `queue:${cs.accountSid}:${this.queueName}`;

    const url = await this._getMemberFromQueue(cs);
    if (!url) this.performAction({dequeueResult: 'timeout'}).catch((err) => {});
    else {
      try {
        await this._dequeueUrl(cs, ep, url);
        this.performAction({dequeueResult: 'complete'}).catch((err) => {});
      } catch (err) {
        this.emitter.removeAllListeners();
        this.performAction({dequeueResult: 'hangup'}).catch((err) => {});
      }
    }
  }

  async kill(cs) {
    super.kill(cs);
    if (this.state === DequeueResults.Bridged) {
      this.logger.info(`TaskDequeue:kill - notifying partner we are going away ${this.partnerUrl}`);
      bent('POST', 202)(this.partnerUrl, {event: 'hangup'}).catch((err) => {
        this.logger.info(err, 'TaskDequeue:kill error notifying partner of hangup');
      });
    }
    this.emitter.emit('kill');
  }

  _getMemberFromQueue(cs) {
    const {popFront} = cs.srf.locals.dbHelpers;

    return new Promise(async(resolve) => {
      let timer;
      let timedout = false, found = false;
      if (this.timeout > 0) {
        timer = setTimeout(() => {
          this.logger.info(`TaskDequeue:_getMemberFromQueue timed out after ${this.timeout}s`);
          timedout = true;
          resolve();
        }, this.timeout * 1000);
      }

      await sleepFor(1000); // to avoid clipping if we dial and immediately connect

      do {
        try {
          const url = await popFront(this.queueName);
          if (url) {
            found = true;
            clearTimeout(timer);
            this.logger.info(`TaskDequeue:_getMemberFromQueue popped ${url} from queue ${this.queueName}`);
            resolve(url);
          }
        } catch (err) {
          this.logger.debug({err}, 'TaskDequeue:_getMemberFromQueue error popFront');
        }
        await sleepFor(5000);
      } while (!this.killed && !timedout && !found);
    });
  }

  _dequeueUrl(cs, ep, url) {
    this.partnerUrl = url;

    return new Promise(async(resolve, reject) => {
      let bridgeTimer;
      this.emitter
        .on('bridged', () => {
          clearTimeout(bridgeTimer);
          this.state = DequeueResults.Bridged;
        })
        .on('hangup', () => {
          this.logger.info('TaskDequeue:_dequeueUrl hangup from partner');
          resolve();
        })
        .on('kill', () => {
          resolve();
        });

      // now notify partner to bridge to me
      try {
        // TODO: if we have a confirmHook, retrieve the app and pass it on
        await bent('POST', 202)(url, {
          event: 'dequeue',
          dequeueSipAddress: cs.srf.locals.localSipAddress,
          epUuid: ep.uuid,
          notifyUrl: getUrl(cs),
          dequeuer: cs.callInfo.toJSON()
        });
        this.logger.info(`TaskDequeue:_dequeueUrl successfully sent POST to ${url}`);
        bridgeTimer = setTimeout(() => reject(new Error('bridge timeout')), 20000);
      } catch (err) {
        this.logger.info({err, url}, `TaskDequeue:_dequeueUrl error dequeueing from ${this.queueName}, try again`);
        reject(new Error('bridge failure'));
      }
    });
  }

  async notifyQueueEvent(cs, opts) {
    if (opts.event === 'ready') {
      assert(opts.notifyUrl && opts.epUuid);
      this.partnerUrl = opts.notifyUrl;
      this.logger.info({opts}, `TaskDequeue:notifyDequeueEvent: about to bridge member from ${this.queueName}`);

      if (this.beep) {
        this.logger.debug({opts}, `TaskDequeue:notifyDequeueEvent: playing beep tone ${this.queueName}`);
        await this.ep.play(BONG_TONE).catch((err) => {
          this.logger.error(err, 'TaskDequeue:notifyDequeueEvent error playing beep');
        });
      }
      await this.ep.bridge(opts.epUuid);
      this.emitter.emit('bridged');
      this.logger.info({opts}, `TaskDequeue:notifyDequeueEvent: successfully bridged member from ${this.queueName}`);
    }
    else if (opts.event === 'hangup') {
      this.emitter.emit('hangup');
    }
    else {
      this.logger.error({opts}, 'TaskDequeue:notifyDequeueEvent - unsupported event/payload');
    }
  }

}

module.exports = TaskDequeue;
