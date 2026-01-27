const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskNoiseIsolation extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    this.preconditions = TaskPreconditions.Endpoint;

    this.vendor = this.data.vendor || 'krisp';
    this.direction = this.data.direction || 'read';
    this.level = typeof this.data.level === 'number' ? this.data.level : 100;
    this.model = this.data.model;
  }

  get name() { return TaskName.NoiseIsolation; }

  get apiCommand() {
    return `uuid_${this.vendor}_noise_isolation`;
  }

  get summary() {
    return `${this.name}{vendor=${this.vendor},direction=${this.direction},level=${this.level}}`;
  }

  async exec(cs, {ep}) {
    await super.exec(cs);
    this.ep = ep;

    if (!ep?.connected) {
      this.logger.info('TaskNoiseIsolation:exec - no endpoint connected');
      this.notifyTaskDone();
      return;
    }

    try {
      await this._startNoiseIsolation(ep);
      await this.awaitTaskDone();
    } catch (err) {
      this.logger.error({err}, 'TaskNoiseIsolation:exec - error');
    }
  }

  async _startNoiseIsolation(ep) {
    // API format: uuid_${vendor}_noise_isolation <uuid> start <direction> [level] [model]
    // model is only added if level is set
    const args = [ep.uuid, 'start', this.direction];
    if (this.level !== 100) {
      args.push(this.level);
      if (this.model) {
        args.push(this.model);
      }
    }

    this.logger.info({args, apiCommand: this.apiCommand}, 'TaskNoiseIsolation:_startNoiseIsolation');

    try {
      const res = await ep.api(this.apiCommand, args.join(' '));
      if (!res.body?.startsWith('+OK')) {
        this.logger.error({res}, 'TaskNoiseIsolation:_startNoiseIsolation - error starting noise isolation');
      } else {
        this.logger.info('TaskNoiseIsolation:_startNoiseIsolation - noise isolation started');
      }
    } catch (err) {
      this.logger.error({err}, 'TaskNoiseIsolation:_startNoiseIsolation - error');
      throw err;
    }
  }

  async _stopNoiseIsolation(ep) {
    if (!ep?.connected) return;

    const args = [ep.uuid, 'stop'];
    this.logger.info({args, apiCommand: this.apiCommand}, 'TaskNoiseIsolation:_stopNoiseIsolation');

    try {
      await ep.api(this.apiCommand, args.join(' '));
      this.logger.info('TaskNoiseIsolation:_stopNoiseIsolation - noise isolation stopped');
    } catch (err) {
      this.logger.info({err}, 'TaskNoiseIsolation:_stopNoiseIsolation - error stopping noise isolation');
    }
  }

  async kill(cs) {
    super.kill(cs);
    await this._stopNoiseIsolation(this.ep);
    this.notifyTaskDone();
  }
}

module.exports = TaskNoiseIsolation;
