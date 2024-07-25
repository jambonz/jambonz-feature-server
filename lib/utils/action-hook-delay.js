const makeTask = require('../tasks/make_task');
const Emitter = require('events');
const { normalizeJambones } = require('@jambonz/verb-specifications');
const {TaskName} = require('../utils/constants');
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
  constructor(logger, opts, cs) {
    super();
    this.logger = logger;
    this.cs = cs;
    this._active = false;

    const enabled = this.init(opts);
    if (enabled && (!this.actions || !Array.isArray(this.actions) || this.actions.length === 0)) {
      throw new Error('ActionHookDelayProcessor: no actions specified');
    }
    else if (enabled && this.actions.some((a) => !a.verb || ![TaskName.Say, TaskName.Play].includes(a.verb))) {
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

  get ep() {
    return this.cs.ep;
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
    this.logger.debug('ActionHookDelayProcessor#start');
    if (this._active) {
      this.logger.debug('ActionHookDelayProcessor#start: already started due to prior gather which is continuing');
      return;
    }
    assert(!this._noResponseTimer);
    this._active = true;
    this._retryCount = 0;
    const timeoutMs =  this.noResponseTimeout === 0 ? 1 : this.noResponseTimeout * 1000;
    this._noResponseTimer = setTimeout(this._onNoResponseTimer.bind(this), timeoutMs);

    if (this.noResponseGiveUpTimeout > 0) {
      const timeoutMs = this.noResponseGiveUpTimeout * 1000;
      this._noResponseGiveUpTimer = setTimeout(this._onNoResponseGiveUpTimer.bind(this), timeoutMs);
    }
  }

  async stop() {
    const error = new Error();
    this.logger.debug({stack: error.stack}, 'ActionHookDelayProcessor#stop');
    this._active = false;

    if (this._noResponseTimer) {
      clearTimeout(this._noResponseTimer);
      this._noResponseTimer = null;
    }
    if (this._noResponseGiveUpTimer) {
      clearTimeout(this._noResponseGiveUpTimer);
      this._noResponseGiveUpTimer = null;
    }
    if (this._taskInProgress) {
      this.logger.debug(`ActionHookDelayProcessor#stop: stopping ${this._taskInProgress.name}`);

      this._sayResolver = async() => {
        this.logger.debug('ActionHookDelayProcessor#stop: play/say is done, continue on..');
        this._taskInProgress.kill(this.cs);
        this._taskInProgress = null;
      };

      /* we let Say finish, but interrupt Play */
      if (TaskName.Play === this._taskInProgress.name) {
        await this._taskInProgress.kill(this.cs);
      }
      return new Promise((resolve) => this._sayResolver = resolve);
    }
    this.logger.debug('ActionHookDelayProcessor#stop returning');
  }

  _onNoResponseTimer() {
    this.logger.debug('ActionHookDelayProcessor#_onNoResponseTimer');
    this._noResponseTimer = null;

    /* get the next play or say action */
    const verb = this.actions[this._retryCount % this.actions.length];

    const t = normalizeJambones(this.logger, [verb]);
    this.logger.debug({verb}, 'ActionHookDelayProcessor#_onNoResponseTimer: starting action');
    try {
      this._taskInProgress = makeTask(this.logger, t[0]);
      this._taskInProgress.disableTracing = true;
      this._taskInProgress.exec(this.cs, {ep: this.ep});
    } catch (err) {
      this.logger.info(err, 'ActionHookDelayProcessor#_onNoResponseTimer: error starting action');
      this._taskInProgress = null;
      return;
    }

    this.ep.once('playback-start', (evt) => {
      this.logger.debug({evt}, 'got playback-start');
      if (!this._active) {
        this.logger.info({evt}, 'ActionHookDelayProcessor#_onNoResponseTimer: killing audio immediately');
        this.ep.api('uuid_break', this.ep.uuid)
          .catch((err) => this.logger.info(err,
            'ActionHookDelayProcessor#_onNoResponseTimer Error killing audio'));
      }
    });

    this.ep.once('playback-stop', (evt) => {
      this._taskInProgress = null;
      if (this._sayResolver) {
        /* we were waiting for the play to finish before continuing to next task */
        this.logger.debug({evt}, 'ActionHookDelayProcessor#_onNoResponseTimer got playback-stop');
        this._sayResolver();
        this._sayResolver = null;
      }
      else {
        /* possibly start the no response timer again */
        if (this._active && this.retries > 0 && this._retryCount < this.retries && this.noResponseTimeout > 0) {
          this.logger.debug({evt}, 'ActionHookDelayProcessor#_onNoResponseTimer: playback-stop on play/say action');
          const timeoutMs = this.noResponseTimeout * 1000;
          this._noResponseTimer = setTimeout(this._onNoResponseTimer.bind(this), timeoutMs);
        }
      }
    });

    this._retryCount++;
  }

  _onNoResponseGiveUpTimer() {
    this._active = false;
    this.logger.info('ActionHookDelayProcessor#_onNoResponseGiveUpTimer');
    this.stop().catch((err) => {});
    this.emit('giveup');
  }
}

module.exports = ActionHookDelayProcessor;
