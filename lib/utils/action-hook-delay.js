const makeTask = require('../tasks/make_task');
const Emitter = require('events');
const assert = require('assert');

/**
 * ActionHookDelayProcessor
 * @extends Emitter
 *
 * @param {Object} logger - logger instance
 * @param {Object} opts - options
 * @param {Object} cs - call session
 * @param {Object} ep - endpoint
 *
 * @emits {Event} 'giveup' - when associated giveup timer expires
 *
 * Ref:https://www.jambonz.org/docs/supporting-articles/handling-action-hook-delays/
 */
class ActionHookDelayProcessor extends Emitter {
  constructor(logger, opts, cs, ep) {
    super();
    this.logger = logger;
    this.cs = cs;
    this.ep = ep;

    this.init(opts);
  }

  get properties() {
    return {
      actions: this.actions,
      retries: this.retries,
      noResponseTimeout: this.noResponseTimeout,
      noResponseGiveUpTimeout: this.noResponseGiveUpTimeout
    };
  }

  init(opts) {
    this.actions = opts.actions;
    this.retries = opts.retries || 0;
    this.noResponseTimeout = opts.noResponseTimeout || 0;
    this.noResponseGiveUpTimeout = opts.noResponseGiveUpTimeout;

    return ('enable' in opts && opts.enable === true) ||
      ('enabled' in opts && opts.enabled === true);
  }

  start() {
    assert(this._noResponseTimer);

    this._retryCount = 0;
    const timeoutMs =  this.noResponseTimeout === 0 ? 1 : this.noResponseTimeout * 1000;
    this._noResponseTimer = setTimeout(this._onNoResponseTimer.bind(this), timeoutMs);

    if (this.noResponseGiveUpTimeout > 0) {
      const timeoutMs = this.noResponseGiveUpTimeout * 1000;
      this._noResponseGiveUpTimer = setTimeout(this._noResponseGiveUpTimer.bind(this), timeoutMs);
    }
  }

  stop() {
    if (this._noResponseTimer) {
      clearTimeout(this._noResponseTimer);
      this._noResponseTimer = null;
    }
    if (this._noResponseGiveUpTimer) {
      clearTimeout(this._noResponseGiveUpTimer);
      this._noResponseGiveUpTimer = null;
    }
    if (this._taskInProgress) {
      this._taskInProgress.kill();
      this._taskInProgress = null;
    }
  }

  _onNoResponseTimer() {
    this.logger.debug('ActionHookDelayProcessor: no response timer expired');
    this._noResponseTimer = null;

    /* if retries are specified, check if we have reached the limit */
    if (this.retries > 0 && this._retryCount === this.retries) {
      this.stop();
      this.emit('giveup');
      return;
    }

    /* get the next play or say action */
    const verb = this.actions[this._retryCount % this.actions.length];
    if (!['say', 'play'].includes(verb.verb)) {
      this.logger.error({action: this.actions}, 'invalid actions, missing verb');
      return;
    }

    /* kill any existing play/say before starting another one */
    if (this._taskInProgress) {
      this._taskInProgress.kill();
    }

    delete verb.verb;
    this._taskInProgress = makeTask(this.logger, {verb});
    this._taskInProgress.exec(this.cs, {ep: this.ep});

    this._retryCount++;

    /* possibly start the no response timer again */
    if (this.retries > 0 && this.noResponseTimeout > 0) {
      const timeoutMs = this.noResponseTimeout * 1000;
      this._noResponseTimer = setTimeout(this._onNoResponseTimer.bind(this), timeoutMs);
    }
  }

  _noResponseGiveUpTimer() {
    this.logger.info('ActionHookDelayProcessor: no response give up timer expired');
    this._stop();
    this.emit('giveup');
  }
}

module.exports = ActionHookDelayProcessor;
