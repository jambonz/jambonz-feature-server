const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const { PlayFileNotFoundError } = require('../utils/error');

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
    let timeout;
    let playbackSeconds = 0;
    let playbackMilliseconds = 0;
    let completed = !(this.timeoutSecs > 0 || this.loop);
    if (this.timeoutSecs > 0) {
      timeout = setTimeout(async() => {
        completed = true;
        try {
          await this.kill(cs);
        } catch (err) {
          this.logger.info(err, 'Error killing audio on timeoutSecs');
        }
      }, this.timeoutSecs * 1000);
    }
    try {
      this.notifyStatus({event: 'start-playback'});
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
          let file = this.url;
          if (this.seekOffset >= 0) {
            file = {file: this.url, seekOffset: this.seekOffset};
            this.seekOffset = -1;
          }
          const result = await ep.play(file);
          playbackSeconds += parseInt(result.playbackSeconds);
          playbackMilliseconds += parseInt(result.playbackMilliseconds);
          if (this.killed || !this.loop || completed) {
            if (timeout) clearTimeout(timeout);
            await this.performAction(
              Object.assign(result, {reason: 'playCompleted', playbackSeconds, playbackMilliseconds}),
              !(this.parentTask || cs.isConfirmCallSession));
          }
        }
      }
    } catch (err) {
      this.logger.info(`TaskPlay:exec - error playing ${this.url}: ${err.message}`);
      this.playComplete = true;
      if (err.message === 'File Not Found') {
        const {writeAlerts, AlertType} = cs.srf.locals;
        await this.performAction({status: 'fail', reason: 'playFailed'}, !(this.parentTask || cs.isConfirmCallSession));
        this.emit('playDone');
        writeAlerts({
          account_sid: cs.accountSid,
          alert_type: AlertType.PLAY_FILENOTFOUND,
          url: this.url,
          target_sid: cs.callSid
        });
        throw new PlayFileNotFoundError(this.url);
      }
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
        this.notifyStatus({event: 'kill-playback'});
        this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
      }
    }
  }
}

module.exports = TaskPlay;
