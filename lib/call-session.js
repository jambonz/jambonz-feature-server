const Emitter = require('events');
/*
const config = require('config');
const {forwardInDialogRequests} = require('drachtio-fn-b2b-sugar');
const {parseUri, SipError} = require('drachtio-srf');
const debug = require('debug')('jambonz:sbc-inbound');
const assert = require('assert');
*/
class CallSession extends Emitter {
  constructor(req, res) {
    super();
    this.req = req;
    this.res = res;
    this.srf = req.srf;
    this.logger = req.locals.logger;
    this.application = req.locals.application;
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
      this.logger.info('finished all tasks');
      if (!this.res.finalResponseSent) {
        this.logger.info('auto-generating non-success response to invite');
        this.res.send(603);
      }
    }
  }
}

module.exports = CallSession;
