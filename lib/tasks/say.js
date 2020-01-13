const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskSay extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.text = this.data.text;
    this.voice = this.data.synthesizer.voice;
    this.earlyMedia = this.data.earlyMedia === true;

    switch (this.data.synthesizer.vendor) {
      case 'google':
        this.ttsEngine = 'google_tts';
        break;
      default:
        throw new Error(`unsupported tts vendor ${this.data.synthesizer.vendor}`);
    }
    this.sayComplete = false;
  }

  get name() { return TaskName.Say; }

  async exec(cs, ep) {
    this.ep = ep;
    try {
      await ep.speak({
        ttsEngine: 'google_tts',
        voice: this.voice,
        text: this.text
      });
    } catch (err) {
      if (err.message !== 'hangup') this.logger.info(err, 'TaskSay:exec error');
    }
    this.emit('playDone');
    this.sayComplete = true;
  }

  kill() {
    if (this.ep.connected && !this.sayComplete) {
      this.logger.debug('TaskSay:kill - killing audio');
      this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
    }
  }
}

module.exports = TaskSay;
