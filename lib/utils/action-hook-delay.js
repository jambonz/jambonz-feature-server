const makeTask = require('../tasks/make_task');
const Emitter = require('events');
const { normalizeJambones } = require('@jambonz/verb-specifications');

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

    const enabled = this.init(opts);
    if (enabled && (!this.actions || !Array.isArray(this.actions) || this.actions.length === 0)) {
      throw new Error('ActionHookDelayProcessor: no actions specified');
    }
    else if (enabled && this.actions.some((a) => !a.verb || !['play', 'say'].includes(a.verb))) {
      throw new Error(`ActionHookDelayProcessor: invalid actions specified: ${JSON.stringify(this.actions)}`);
    }
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
    this.logger.debug({opts}, 'ActionHookDelayProcessor#init');

    this.actions = opts.actions;
    this.retries = opts.retries || 0;
    this.noResponseTimeout = opts.noResponseTimeout || 0;
    this.noResponseGiveUpTimeout = opts.noResponseGiveUpTimeout;

    // return false if these options actually disable the ahdp
    return ('enable' in opts && opts.enable === true) ||
      ('enabled' in opts && opts.enabled === true) ||
      (!('enable' in opts) && !('enabled' in opts));
  }

  start() {
    if (this._noResponseTimer) {
      this.logger.debug('ActionHookDelayProcessor#start: already started due to prior gather which is continuing');
      return;
    }
    this.logger.debug('ActionHookDelayProcessor#start');
    this._retryCount = 0;
    const timeoutMs =  this.noResponseTimeout === 0 ? 1 : this.noResponseTimeout * 1000;
    this._noResponseTimer = setTimeout(this._onNoResponseTimer.bind(this), timeoutMs);

    if (this.noResponseGiveUpTimeout > 0) {
      const timeoutMs = this.noResponseGiveUpTimeout * 1000;
      this._noResponseGiveUpTimer = setTimeout(this._noResponseGiveUpTimer.bind(this), timeoutMs);
    }
  }

  stop() {
    this.logger.debug('ActionHookDelayProcessor#stop');
    if (this._noResponseTimer) {
      clearTimeout(this._noResponseTimer);
      this._noResponseTimer = null;
    }
    if (this._noResponseGiveUpTimer) {
      clearTimeout(this._noResponseGiveUpTimer);
      this._noResponseGiveUpTimer = null;
    }
    if (this._taskInProgress) {
      this.logger.debug(`ActionHookDelayProcessor#stop: killing task in progress: ${this._taskInProgress.name}`);
      this._taskInProgress.kill(this.cs);
      this._taskInProgress = null;
    }
  }

  _onNoResponseTimer() {
    this.logger.debug('ActionHookDelayProcessor#_onNoResponseTimer');
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
      this._taskInProgress.kill(this.cs);
    }

    const t = normalizeJambones(this.logger, [verb]);
    this.logger.debug({verb}, 'ActionHookDelayProcessor#_onNoResponseTimer: starting action');
    this._taskInProgress = makeTask(this.logger, t[0]);
    this._taskInProgress.disableTracing = true;
    this._taskInProgress.exec(this.cs, {ep: this.ep});

    this._retryCount++;

    /* possibly start the no response timer again */
    if (this.retries > 0 && this.noResponseTimeout > 0) {
      this.ep.once('playback-stop', (evt) => {
        this.logger.debug({evt}, 'ActionHookDelayProcessor#_onNoResponseTimer: playback-stop event on play/say action');
      });
      const timeoutMs = this.noResponseTimeout * 1000;
      this._noResponseTimer = setTimeout(this._onNoResponseTimer.bind(this), timeoutMs);
    }
  }

  _noResponseGiveUpTimer() {
    this.logger.info('ActionHookDelayProcessor#_noResponseGiveUpTimer');
    this.stop();
    this.emit('giveup');
  }
}

module.exports = ActionHookDelayProcessor;
