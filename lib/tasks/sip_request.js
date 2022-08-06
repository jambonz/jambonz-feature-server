const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

/**
 * Send a SIP request (e.g. INFO, NOTIFY, etc) on an existing call leg
 */
class TaskSipRequest extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.StableCall;

    this.method = this.data.method.toUpperCase();
    this.headers = this.data.headers || {};
    this.body = this.data.body;
    if (this.body) this.body = `${this.body}\n`;
  }

  get name() { return TaskName.SipRequest; }

  async exec(cs, {dlg}) {
    super.exec(cs);
    try {
      this.logger.info({dlg}, `TaskSipRequest: sending a SIP ${this.method}`);
      const res = await dlg.request({
        method: this.method,
        headers: this.headers,
        body: this.body
      });
      const result = {result: 'success', sipStatus: res.status};
      this.span.setAttributes({
        ...this.headers,
        ...(this.body && {body: this.body}),
        'response.status_code': res.status
      });
      this.logger.debug({result}, `TaskSipRequest: received response to ${this.method}`);
      await this.performAction(result);
    } catch (err) {
      this.logger.error({err}, 'TaskSipRequest: error');
      this.span.setAttributes({
        ...this.headers,
        ...(this.body && {body: this.body}),
        'response.error': err.message
      });
      await this.performAction({result: 'failed', err: err.message});
    }
  }
}

module.exports = TaskSipRequest;
