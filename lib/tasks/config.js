const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskConfig extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    logger.debug({opts}, 'TaskConfig');
    ['synthesizer', 'recognizer', 'botMode'].forEach((prop) => {
      this[prop] = opts[prop] || {};
    });
  }

  get name() { return TaskName.Config; }

  get hasSynthesizer() { return Object.keys(this.synthesizer).length; }

  get hasRecognizer() { return Object.keys(this.recognizer).length; }

  get hasBotMode() { return Object.keys(this.botMode).length; }

  async exec(cs) {
    await super.exec(cs);

    if (this.hasSynthesizer) {
      cs.speechSynthesisVendor = this.synthesizer.vendor || cs.speechSynthesisVendor;
      cs.speechSynthesisLanguage = this.synthesizer.language || cs.speechSynthesisLanguage;
      cs.speechSynthesisVoice = this.synthesizer.voice || cs.speechSynthesisVoice;
      this.logger.info({synthesizer: this.synthesizer}, 'Config: updated synthesizer');
    }
    if (this.hasRecognizer) {
      cs.speechRecognizerVendor = this.recognizer.vendor || cs.speechRecognizerVendor;
      cs.speechRecognizerLanguage = this.recognizer.language || cs.speechRecognizerLanguage;
      this.logger.info({recognizer: this.recognizer}, 'Config: updated recognizer');
    }
    if (this.botMode) {
      if (this.botMode.enable) {
        cs.enableBotMode(this.botMode.gather);
      }
      else {
        cs.disableBotMode();
      }
    }
  }

  async kill(cs) {
    super.kill(cs);
  }
}

module.exports = TaskConfig;
