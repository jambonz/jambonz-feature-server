const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskPlay extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.url = this.data.url;
    this.seekOffset = this.data.seekOffset || -1;
    this.timeoutSecs = this.data.timeoutSecs || -1;
    this.loop = this.data.loop || 1;
    this.earlyMedia = this.data.earlyMedia === true;
  }

  get name() { return TaskName.Play; }

  get summary() {
    return `${this.name}:{url=${this.url}}`;
  }

  async exec(cs, {ep}) {
    await super.exec(cs);
    this.ep = ep;
    try {
      while (!this.killed && (this.loop === 'forever' || this.loop--) && this.ep.connected) {
        if (cs.isInConference) {
          const {memberId, confName, confUuid} = cs;
          if (Array.isArray(this.url)) {
            for (const playUrl of this.url) {
              await this.playToConfMember(this.ep, memberId, confName, confUuid, playUrl);
            }
          } else {
            await this.playToConfMember(this.ep, memberId, confName, confUuid, this.url);
          }
        } else {
          const file = (this.timeoutSecs >= 0 || this.seekOffset >= 0) ?
            {file: this.url, seekOffset: this.seekOffset, timeoutSecs: this.timeoutSecs} : this.url;
          const result = await ep.play(file);
          await this.performAction(Object.assign(result, {reason: 'playCompleted'}),
            !(this.parentTask || cs.isConfirmCallSession));
        }
      }
    } catch (err) {
      this.logger.info(err, `TaskPlay:exec - error playing ${this.url}`);
    }
    this.emit('playDone');
  }

  async kill(cs) {
    super.kill(cs);
    if (this.ep.connected && !this.playComplete) {
      this.logger.debug('TaskPlay:kill - killing audio');
      if (cs.isInConference) {
        const {memberId, confName} = cs;
        this.killPlayToConfMember(this.ep, memberId, confName);
      }
      else {
        await this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
      }
    }
  }
}

module.exports = TaskPlay;
