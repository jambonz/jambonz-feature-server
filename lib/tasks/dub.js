const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const assert = require('assert');

/**
 * Answer the call.
 * Note: This is rarely used, as the call is typically answered automatically when required by the app,
 * but it can be useful to force an answer before a pause in some cases
 */
class TaskDub extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    ['action', 'track', 'play', 'say', 'loop'].forEach((prop) => {
      this[prop] = this.data[prop];
    });

    assert.ok(this.action, 'TaskDub: action is required');
    assert.ok(this.track, 'TaskDub: track is required');
  }

  get name() { return TaskName.Dub; }

  async exec(cs, {ep}) {
    super.exec(cs);

    try {
      switch (this.action) {
        case 'addTrack':
          await this._addTrack(ep);
          break;
        case 'removeTrack':
          await this._removeTrack(ep);
          break;
        case 'silenceTrack':
          await this._silenceTrack(ep);
          break;
        case 'playOnTrack':
          await this._playOnTrack(ep);
          break;
        case 'sayOnTrack':
          await this._sayOnTrack(ep);
          break;
        default:
          throw new Error(`TaskDub: unsupported action ${this.action}`);
      }
    } catch (err) {
      this.logger.error(err, 'Error executing dub task');
    }
  }

  async _addTrack(ep) {
    this.logger.info(`adding track: ${this.track}`);
    await ep.api('uuid_dub', [ep.uuid, 'addTrack', this.track]);
  }
  async _removeTrack(ep) {
    this.logger.info(`removing track: ${this.track}`);
    await ep.api('uuid_dub', [ep.uuid, 'removeTrack', this.track]);
  }
  async _silenceTrack(ep) {
    this.logger.info(`silencing track: ${this.track}`);
    await ep.api('uuid_dub', [ep.uuid, 'silenceTrack', this.track]);
  }
  async _playOnTrack(ep) {
    this.logger.info(`playing on track: ${this.track}`);
    await ep.api('uuid_dub', [ep.uuid, 'playOnTrack', this.track, this.play]);
  }
  async _sayOnTrack(ep) {
    this.logger.info(`saying on track: ${this.track}`);
    await ep.api('uuid_dub', [ep.uuid, 'sayOnTrack', this.track, this.say]);
  }
}

module.exports = TaskDub;
