const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskSayLegacy extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.text = this.data.text;
    this.loop = this.data.loop || 1;
    this.earlyMedia = this.data.earlyMedia === true || (parentTask && parentTask.earlyMedia);
    if (this.data.synthesizer) {
      this.voice = this.data.synthesizer.voice;
      switch (this.data.synthesizer.vendor) {
        case 'google':
          this.ttsEngine = 'google_tts';
          break;
        default:
          throw new Error(`unsupported tts vendor ${this.data.synthesizer.vendor}`);
      }
    }
  }

  get name() { return TaskName.SayLegacy; }

  async exec(cs, {ep}) {
    super.exec(cs);
    this.ep = ep;
    try {
      while (!this.killed && this.loop--) {
        this.logger.debug(`TaskSayLegacy: remaining loops ${this.loop}`);
        await ep.speak({
          ttsEngine: 'google_tts',
          voice: this.voice || this.callSession.speechSynthesisVoice,
          text: this.text
        });
      }
    } catch (err) {
      this.logger.info(err, 'TaskSayLegacy:exec error');
    }
    this.emit('playDone');
  }

  async kill() {
    super.kill();
    if (this.ep.connected) {
      this.logger.debug('TaskSayLegacy:kill - killing audio');
      await this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
    }
  }
}

module.exports = TaskSayLegacy;
