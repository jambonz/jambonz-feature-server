const Task = require('./task');
const {TaskName, TaskPreconditions, DequeueResults} = require('../utils/constants');
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

    this.emitter = new Emitter();
    this.state = DequeueResults.Timeout;
  }

  get name() { return TaskName.Dequeue; }

  async exec(cs, ep) {
    await super.exec(cs);
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

      do {
        try {
          const url = await popFront(this.queueName);
          if (url) {
            found = true;
            clearTimeout(timer);
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
        await bent('POST', 202)(url, {
          event: 'dequeue',
          dequeueSipAddress: cs.srf.locals.localSipAddress,
          epUuid: ep.uuid,
          notifyUrl: getUrl(cs)
        });
        bridgeTimer = setTimeout(() => reject(new Error('bridge timeout')), 20000);
      } catch (err) {
        this.logger.info({err, url}, `TaskDequeue:_dequeueUrl error dequeueing from ${this.queueName}, try again`);
        reject(new Error('bridge failure'));
      }
    });
  }

  notifyQueueEvent(cs, opts) {
    if (opts.event === 'bridged') {
      assert(opts.notifyUrl);
      this.logger.info({opts}, `TaskDequeue:notifyDequeueEvent: successfully bridged to member from ${this.queueName}`);
      this.partnerUrl = opts.notifyUrl;
      this.emitter.emit('bridged');
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
