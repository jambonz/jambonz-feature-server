const Task = require('./task');
const {TaskName} = require('../utils/constants');
const WsRequestor = require('../utils/ws-requestor');
const {URL} = require('url');
const HttpRequestor = require('../utils/http-requestor');

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

    const isAbsoluteUrl = cs.application?.requestor?._isAbsoluteUrl(this.actionHook);

    if (isAbsoluteUrl) {
      this.logger.info(`TaskRedirect redirecting to new absolute URL ${this.actionHook}, requires new requestor`);

      if (cs.requestor instanceof WsRequestor) {
        try {
          const requestor = new WsRequestor(this.logger, cs.accountSid, {url: this.actionHook},
            cs.accountInfo.account.webhook_secret) ;
          cs.requestor.emit('handover', requestor);
        } catch (err) {
          this.logger.info(err, `TaskRedirect error redirecting to ${this.actionHook}`);
        }
      }
      else {
        const baseUrl =  this.cs.application.requestor.baseUrl;
        const newUrl = new URL(this.actionHook);
        const newBaseUrl = newUrl.protocol + '//' + newUrl.host;
        if (baseUrl != newBaseUrl) {
          try {
            this.logger.info(`Task:redirect updating base url to ${newBaseUrl}`);
            const newRequestor = new HttpRequestor(this.logger, cs.accountSid, {url: this.actionHook},
              cs.accountInfo.account.webhook_secret);
            cs.requestor.emit('handover', newRequestor);
          } catch (err) {
            this.logger.info(err, `TaskRedirect error updating base url to ${this.actionHook}`);
          }
        }
      }
    }

    /* update the notifier if a new statusHook was provided */
    this.logger.info(this.statusHook)
    if (this.statusHook) {
      const isStatusHookAbsolute = cs.application?.requestor?._isAbsoluteUrl(this.statusHook);
      if (isStatusHookAbsolute) {
        this.logger.info(`TaskRedirect updating notifier to new absolute URL ${this.statusHook}`);
        try {
          const oldNotifier = cs.application.notifier;
          if (cs.notifier instanceof WsRequestor) {
            cs.application.notifier = new WsRequestor(this.logger, cs.accountSid, {url: this.statusHook},
              cs.accountInfo.account.webhook_secret);
          } else {
            cs.application.notifier = new HttpRequestor(this.logger, cs.accountSid, {url: this.statusHook},
              cs.accountInfo.account.webhook_secret);
          }
          if (oldNotifier?.close) oldNotifier.close();
        } catch (err) {
          this.logger.info(err, `TaskRedirect error updating notifier to ${this.statusHook}`);
        }
      }
    }

    await this.performAction();
  }
}

module.exports = TaskRedirect;
