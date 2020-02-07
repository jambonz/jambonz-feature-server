const Emitter = require('events');
const assert = require('assert');

class SessionTracker extends Emitter {
  constructor() {
    super();

    this.sessions = new Map();
  }

  get logger() {
    if (!this._logger) {
      const {logger} = require('../../app');
      this._logger = logger;
    }
    return this._logger;
  }

  add(callSid, callSession) {
    assert(callSid);
    this.sessions.set(callSid, callSession);
    this.logger.info(`SessionTracker:add callSid ${callSid}, we have ${this.sessions.size} session being tracked`);
  }

  remove(callSid) {
    assert(callSid);
    this.sessions.delete(callSid);
    this.logger.info(`SessionTracker:remove callSid ${callSid}, we have ${this.sessions.size} being tracked`);
  }

  has(callSid) {
    return this.sessions.has(callSid);
  }

  get(callSid) {
    return this.sessions.get(callSid);
  }
}

const singleton = new SessionTracker();

module.exports = singleton;
