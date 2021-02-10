const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskSay extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.text = Array.isArray(this.data.text) ? this.data.text : [this.data.text];
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
      // synthesize all of the text elements
      const files = (await Promise.all(this.text.map(async(text) => {
        const {filePath} = await synthAudio({
          text,
          vendor: this.synthesizer.vendor || cs.speechSynthesisVendor,
          language: this.synthesizer.language || cs.speechSynthesisLanguage,
          voice: this.synthesizer.voice || cs.speechSynthesisVoice,
          salt: cs.callSid
        }).catch((err) => this.logger.error(err, 'Error synthesizing text'));
        if (filePath) cs.trackTmpFile(filePath);
        return filePath;
      })))
        .filter((fp) => fp && fp.length);

      this.logger.debug({files}, 'synthesized files for tts');

      while (!this.killed && this.loop-- && this.ep.connected) {
        let segment = 0;
        do {
          await ep.play(files[segment]);
        } while (!this.killed && ++segment < files.length);
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
