const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskConfig extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    [
      'synthesizer',
      'recognizer',
      'bargeIn',
      'record'
    ].forEach((k) => this[k] = this.data[k] || {});

    if (this.bargeIn.enable) {
      this.gatherOpts = {
        verb: 'gather',
        timeout: 0,
        bargein: true,
        input: ['speech']
      };
      [
        'finishOnKey', 'input', 'numDigits', 'minDigits', 'maxDigits',
        'interDigitTimeout', 'bargein', 'dtmfBargein', 'minBargeinWordCount', 'actionHook'
      ].forEach((k) => {
        if (this.bargeIn[k]) this.gatherOpts[k] = this.bargeIn[k];
      });
    }
    if (this.bargeIn.sticky) this.autoEnable = true;
    this.preconditions = this.bargeIn.enable ? TaskPreconditions.Endpoint : TaskPreconditions.None;
  }

  get name() { return TaskName.Config; }

  get hasSynthesizer() { return Object.keys(this.synthesizer).length; }

  get hasRecognizer() { return Object.keys(this.recognizer).length; }

  get summary() {
    const phrase = [];
    if (this.bargeIn.enable) phrase.push('enable barge-in');
    if (this.hasSynthesizer) {
      const {vendor:v, language:l, voice} = this.synthesizer;
      const s = `{${v},${l},${voice}}`;
      phrase.push(`set synthesizer${s}`);
    }
    if (this.hasRecognizer) {
      const {vendor:v, language:l} = this.recognizer;
      const s = `{${v},${l}}`;
      phrase.push(`set recognizer${s}`);
    }
    return  `${this.name}{${phrase.join(',')}`;
  }

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
      cs.isContinuousAsr = typeof this.recognizer.asrTimeout === 'number' ? true : false;
      if (cs.isContinuousAsr) {
        cs.asrTimeout = this.recognizer.asrTimeout;
        cs.asrDtmfTerminationDigit = this.recognizer.asrDtmfTerminationDigit;
      }
      this.logger.info({
        recognizer: this.recognizer,
        isContinuousAsr: cs.isContinuousAsr
      }, 'Config: updated recognizer');
    }
    if ('enable' in this.bargeIn) {
      if (this.gatherOpts) {
        this.gatherOpts.recognizer = this.hasRecognizer ?
          this.recognizer :
          {
            vendor: cs.speechRecognizerVendor,
            language: cs.speechRecognizerLanguage
          };
        this.logger.info({opts: this.gatherOpts}, 'Config: enabling bargeIn');
        cs.enableBotMode(this.gatherOpts, this.autoEnable);
      }
      else {
        this.logger.info('Config: disabling bargeIn');
        cs.disableBotMode();
      }
    }
    if (this.record.action) cs.notifyRecordOptions(this.record);
  }

  async kill(cs) {
    super.kill(cs);
  }
}

module.exports = TaskConfig;
