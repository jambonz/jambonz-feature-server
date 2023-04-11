const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskConfig extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    [
      'synthesizer',
      'recognizer',
      'bargeIn',
      'record',
      'listen'
    ].forEach((k) => this[k] = this.data[k] || {});

    if ('notifyEvents' in this.data) {
      this.notifyEvents = !!this.data.notifyEvents;
    }

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
    this.preconditions = (this.bargeIn.enable || this.record?.action || this.listen?.url || this.data.amd) ?
      TaskPreconditions.Endpoint :
      TaskPreconditions.None;
  }

  get name() { return TaskName.Config; }

  get hasSynthesizer() { return Object.keys(this.synthesizer).length; }
  get hasRecognizer() { return Object.keys(this.recognizer).length; }
  get hasRecording() { return Object.keys(this.record).length; }
  get hasListen() { return Object.keys(this.listen).length; }

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
    if (this.hasRecording) phrase.push(this.record.action);
    if (this.hasListen) {
      phrase.push(this.listen.enable ? `listen ${this.listen.url}` : 'stop listen');
    }
    if (this.data.amd) phrase.push('enable amd');
    if (this.notifyEvents) phrase.push(`event notification ${this.notifyEvents ? 'on' : 'off'}`);
    return `${this.name}{${phrase.join(',')}`;
  }

  async exec(cs, {ep} = {}) {
    await super.exec(cs);

    if (this.notifyEvents) {
      this.logger.debug(`turning event notification ${this.notifyEvents ? 'on' : 'off'}`);
      cs.notifyEvents = !!this.data.notifyEvents;
    }

    if (this.data.amd) {
      this.startAmd = cs.startAmd;
      this.stopAmd = cs.stopAmd;
      this.on('amd', this._onAmdEvent.bind(this, cs));

      try {
        this.ep = ep;
        this.startAmd(cs, ep, this, this.data.amd);
      } catch (err) {
        this.logger.info({err}, 'Config:exec - Error calling startAmd');
      }
    }

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
      if (Array.isArray(this.recognizer.hints)) {
        const obj = {hints: this.recognizer.hints};
        if (typeof this.recognizer.hintsBoost === 'number') {
          obj.hintsBoost = this.recognizer.hintsBoost;
        }
        cs.globalSttHints = obj;
      }
      if (Array.isArray(this.recognizer.altLanguages)) {
        this.logger.info({altLanguages: this.recognizer.altLanguages}, 'Config: updated altLanguages');
        cs.altLanguages = this.recognizer.altLanguages;
      }
      if ('punctuation' in this.recognizer) {
        cs.globalSttPunctuation = this.recognizer.punctuation;
      }
      this.logger.info({
        recognizer: this.recognizer,
        isContinuousAsr: cs.isContinuousAsr
      }, 'Config: updated recognizer');
    }
    if ('enable' in this.bargeIn) {
      if (this.bargeIn.enable === true && this.gatherOpts) {
        this.gatherOpts.recognizer = this.hasRecognizer ?
          this.recognizer :
          {
            vendor: cs.speechRecognizerVendor,
            language: cs.speechRecognizerLanguage
          };
        this.logger.info({opts: this.gatherOpts}, 'Config: enabling bargeIn');
        cs.enableBotMode(this.gatherOpts, this.autoEnable);
      }
      else if (this.bargeIn.enable === false) {
        this.logger.info('Config: disabling bargeIn');
        cs.disableBotMode();
      }
    }
    if (this.record.action) {
      try {
        await cs.notifyRecordOptions(this.record);
      } catch (err) {
        this.logger.info({err}, 'Config: error starting recording');
      }
    }
    if (this.hasListen) {
      const {enable, ...opts} = this.listen;
      if (enable) {
        this.logger.debug({opts}, 'Config: enabling listen');
        cs.startBackgroundListen({verb: 'listen', ...opts});
      } else {
        this.logger.info('Config: disabling listen');
        cs.stopBackgroundListen();
      }
    }
  }

  async kill(cs) {
    super.kill(cs);
    //if (this.ep && this.stopAmd) this.stopAmd(this.ep, this);
  }

  _onAmdEvent(cs, evt) {
    this.logger.info({evt}, 'Config:_onAmdEvent');
    const {actionHook} = this.data.amd;
    this.performHook(cs, actionHook, evt)
      .catch((err) => {
        this.logger.error({err}, 'Config:_onAmdEvent - error calling actionHook');
      });

  }
}

module.exports = TaskConfig;
