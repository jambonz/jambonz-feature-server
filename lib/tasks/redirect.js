const Task = require('./task');
const {TaskName} = require('../utils/constants');
const WsRequestor = require('../utils/ws-requestor');

/**
 * Redirects to a new application
 */
class TaskRedirect extends Task {
  constructor(logger, opts) {
    super(logger, opts);
  }

  get name() { return TaskName.Redirect; }

  async exec(cs) {
    await super.exec(cs);

    if (cs.requestor instanceof WsRequestor && cs.application.requestor._isAbsoluteUrl(this.actionHook)) {
      this.logger.info(`Task:performAction redirecting to ${this.actionHook}, requires new ws connection`);
      try {
        this.cs.requestor.close();
        const requestor = new WsRequestor(this.logger, cs.accountSid, {url: this.actionHook}, this.webhook_secret) ;
        this.cs.application.requestor = requestor;
      } catch (err) {
        this.logger.info(err, `Task:performAction error redirecting to ${this.actionHook}`);
      }
    }
    await this.performAction();
  }
}

module.exports = TaskRedirect;
