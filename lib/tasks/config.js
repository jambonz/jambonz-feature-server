const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskConfig extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    [
      'synthesizer',
      'recognizer',
      'bargeIn'
    ].forEach((k) => this[k] = this.data[k] || {});

    if (this.hasBargeIn && this.bargeIn.enable === true) {
      this.gatherOpts = {
        verb: 'gather',
        timeout: 0
      };
      [
        'finishOnKey', 'input', 'numDigits', 'minDigits', 'maxDigits',
        'interDigitTimeout', 'dtmfBargein', 'actionHook'
      ].forEach((k) => {
        if (this.bargeIn[k]) this.gatherOpts[k] = this.bargeIn[k];
      });

      this.preconditions = this.hasBargeIn ? TaskPreconditions.Endpoint : TaskPreconditions.None;
    }
  }

  get name() { return TaskName.Config; }

  get hasSynthesizer() { return Object.keys(this.synthesizer).length; }

  get hasRecognizer() { return Object.keys(this.recognizer).length; }

  get hasBargeIn() { return Object.keys(this.bargeIn).length; }

  async exec(cs) {
    await super.exec(cs);

    if (this.hasSynthesizer) {
      cs.speechSynthesisVendor = this.synthesizer.vendor !== 'default'
        ? this.synthesizer.vendor
        : cs.speechSynthesisVendor;
      cs.speechSynthesisLanguage = this.synthesizer.language !== 'default'
        ?  this.synthesizer.language
        : cs.speechSynthesisLanguage;
      cs.speechSynthesisVoice = this.synthesizer.voice !== 'default'
        ? this.synthesizer.voice
        : cs.speechSynthesisVoice;
      this.logger.info({synthesizer: this.synthesizer}, 'Config: updated synthesizer');
    }
    if (this.hasRecognizer) {
      cs.speechRecognizerVendor = this.recognizer.vendor !== 'default'
        ? this.recognizer.vendor
        : cs.speechRecognizerVendor;
      cs.speechRecognizerLanguage = this.recognizer.language !== 'default'
        ? this.recognizer.language
        : cs.speechRecognizerLanguage;
      this.logger.info({recognizer: this.recognizer}, 'Config: updated recognizer');
    }
    if (this.hasBargeIn) {
      if (this.gatherOpts) {
        this.logger.debug({opts: this.gatherOpts}, 'Config: enabling bargeIn');
        cs.enableBotMode(this.gatherOpts);
      }
      else {
        this.logger.debug('Config: disabling bargeIn');
        cs.disableBotMode();
      }
    }
  }

  async kill(cs) {
    super.kill(cs);
  }
}

module.exports = TaskConfig;
