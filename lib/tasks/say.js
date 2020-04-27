const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskSay extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.text = this.data.text;
    this.loop = this.data.loop || 1;
    this.earlyMedia = this.data.earlyMedia === true || (parentTask && parentTask.earlyMedia);
    this.synthesizer = this.data.synthesizer || {};
  }

  get name() { return TaskName.Say; }

  async exec(cs, ep) {
    const {srf} = cs;
    const {synthAudio} = srf.locals.dbHelpers;
    await super.exec(cs);
    this.ep = ep;
    try {
      let filepath;
      const opts = Object.assign({
        text: this.text,
        vendor: cs.speechSynthesisVendor,
        language: cs.speechSynthesisLanguage,
        voice: cs.speechSynthesisVoice
      }, this.synthesizer);

      while (!this.killed && this.loop--) {
        if (!filepath) {
          this.logger.debug('TaskSay:exec - retrieving synthesized audio');
          filepath = await synthAudio(opts);
          cs.trackTmpFile(filepath);
        }
        await ep.play(filepath);
      }
    } catch (err) {
      this.logger.info(err, 'TaskSay:exec error');
    }
    this.emit('playDone');
  }

  async kill(cs) {
    super.kill(cs);
    if (this.ep.connected) {
      this.logger.debug('TaskSay:kill - killing audio');
      await this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
    }
  }
}

module.exports = TaskSay;
