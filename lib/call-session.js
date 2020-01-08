const Emitter = require('events');
const config = require('config');

class CallSession extends Emitter {
  constructor(req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = req.locals.logger;
    this.application = req.locals.application;
    this.resources = new Map();

    req.on('cancel', this._onCallerHangup.bind(this));

    this.on('callStatusChange', this._onCallStatusChange.bind(this));
  }

  async exec() {
    let idx = 0;
    for (const task of this.application.tasks) {
      try {
        this.logger.debug(`CallSession: executing task #${++idx}: ${task.name}`);
        const continueOn = await task.exec(this);
        if (!continueOn) break;
      } catch (err) {
        this.logger.error({err, task}, 'Error executing task');
      }
      this.logger.info('CallSession: finished all tasks');
      if (!this.res.finalResponseSent) {
        this.logger.info('CallSession: auto-generating non-success response to invite');
        this.res.send(603);
      }
      this._clearResources();
    }
  }

  addResource(name, resource) {
    this.logger.debug(`CallSession:addResource: adding ${name}`);
    this.resources.set(name, resource);
  }

  getResource(name) {
    return this.resources.get(name);
  }

  removeResource(name) {
    this.logger.debug(`CallSession:removeResource: removing ${name}`);
    this.resources.delete(name);
  }

  async createOrRetrieveEpAndMs(remoteSdp) {
    const mrf = this.srf.locals.mrf;
    let ms = this.getResource('ms');
    let ep = this.getResource('epIn');
    if (ms && ep) return {ms, ep};

    // get a media server
    if (!ms) {
      ms = await mrf.connect(config.get('freeswitch'));
      this.addResource('ms', ms);
    }
    if (!ep) {
      ep = await ms.createEndpoint({remoteSdp});
      this.addResource('epIn', ep);
    }
    return {ms, ep};
  }

  /**
   * clear down resources
   * (note: we remove in reverse order they were added since mediaserver
   * is typically added first and I prefer to destroy it after any resources it holds)
   */
  _clearResources() {
    for (const [name, resource] of Array.from(this.resources).reverse()) {
      try {
        this.logger.info(`CallSession:_clearResources: deleting ${name}`);
        if (resource.connected) resource.destroy();
      } catch (err) {
        this.logger.error(err, `CallSession:_clearResources: error deleting ${name}`);
      }
    }
  }

  _onCallerHangup(evt) {
    this.logger.debug('CallSession: caller hung before connection');
  }
  _onCallStatusChange(evt) {
    this.logger.debug(evt, 'CallSession:_onCallStatusChange');
  }
}

module.exports = CallSession;
