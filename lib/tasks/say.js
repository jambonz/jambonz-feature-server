const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskSay extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.text = this.data.text;
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

  get name() { return TaskName.Say; }

  async exec(cs, ep) {
    super.exec(cs);
    this.ep = ep;
    try {
      await ep.speak({
        ttsEngine: 'google_tts',
        voice: this.voice || this.callSession.speechSynthesisVoice,
        text: this.text
      });
    } catch (err) {
      this.logger.info(err, 'TaskSay:exec error');
    }
    this.emit('playDone');
  }

  kill() {
    super.kill();
    if (this.ep.connected) {
      this.logger.debug('TaskSay:kill - killing audio');
      this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
    }
  }
}

module.exports = TaskSay;
