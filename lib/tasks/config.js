const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const parseDecibels = require('../utils/parse-decibels');

class TaskConfig extends Task {
  constructor(logger, opts) {
    super(logger, opts);

    [
      'synthesizer',
      'recognizer',
      'bargeIn',
      'record',
      'listen',
      'transcribe',
      'fillerNoise',
      'actionHookDelayAction',
      'boostAudioSignal',
      'vad'
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
    if (this.transcribe?.enable) {
      this.transcribeOpts = {
        verb: 'transcribe',
        ...this.transcribe
      };
      delete this.transcribeOpts.enable;
    }

    if (this.data.reset) {
      if (typeof this.data.reset === 'string') this.data.reset = [this.data.reset];
    }
    else this.data.reset = [];

    if (this.bargeIn.sticky) this.autoEnable = true;
    this.preconditions = (this.bargeIn.enable ||
      this.record?.action ||
      this.listen?.url ||
      this.data.amd ||
      'boostAudioSignal' in this.data ||
      this.transcribe?.enable) ?
      TaskPreconditions.Endpoint :
      TaskPreconditions.None;

    this.onHoldMusic = this.data.onHoldMusic;
  }

  get name() { return TaskName.Config; }

  get hasSynthesizer() { return Object.keys(this.synthesizer).length; }
  get hasRecognizer() { return Object.keys(this.recognizer).length; }
  get hasRecording() { return Object.keys(this.record).length; }
  get hasListen() { return Object.keys(this.listen).length; }
  get hasTranscribe() { return Object.keys(this.transcribe).length; }
  get hasDub() { return Object.keys(this.dub).length; }
  get hasVad() { return Object.keys(this.vad).length; }
  get hasFillerNoise() { return Object.keys(this.fillerNoise).length; }

  get summary() {
    const phrase = [];

    /* reset recognizer and/or synthesizer to default values? */
    if (this.data.reset.length) phrase.push(`reset ${this.data.reset.join(',')}`);

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
    if (this.hasTranscribe) {
      phrase.push(this.transcribe.enable ? `transcribe ${this.transcribe.transcriptionHook}` : 'stop transcribe');
    }
    if (this.hasFillerNoise) phrase.push(`fillerNoise ${this.fillerNoise.enable ? 'on' : 'off'}`);
    if (this.data.amd) phrase.push('enable amd');
    if (this.notifyEvents) phrase.push(`event notification ${this.notifyEvents ? 'on' : 'off'}`);
    if (this.onHoldMusic) phrase.push(`onHoldMusic: ${this.onHoldMusic}`);
    if ('boostAudioSignal' in this.data) phrase.push(`setGain ${this.data.boostAudioSignal}`);
    return `${this.name}{${phrase.join(',')}}`;
  }

  async exec(cs, {ep} = {}) {
    await super.exec(cs);

    if (this.notifyEvents) {
      this.logger.debug(`turning event notification ${this.notifyEvents ? 'on' : 'off'}`);
      cs.notifyEvents = !!this.data.notifyEvents;
    }

    if (this.onHoldMusic) {
      cs.onHoldMusic = this.onHoldMusic;
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

    this.data.reset.forEach((k) => {
      if (k === 'synthesizer') cs.resetSynthesizer();
      else if (k === 'recognizer') cs.resetRecognizer();
    });

    if (this.hasSynthesizer) {
      cs.synthesizer = this.synthesizer;
      cs.speechSynthesisVendor = this.synthesizer.vendor !== 'default'
        ? this.synthesizer.vendor
        : cs.speechSynthesisVendor;
      cs.speechSynthesisLabel = this.synthesizer.label !== 'default'
        ? this.synthesizer.label
        : cs.speechSynthesisLabel;
      cs.speechSynthesisLanguage = this.synthesizer.language !== 'default'
        ?  this.synthesizer.language
        : cs.speechSynthesisLanguage;
      cs.speechSynthesisVoice = this.synthesizer.voice !== 'default'
        ? this.synthesizer.voice
        : cs.speechSynthesisVoice;

      // fallback vendor
      cs.fallbackSpeechSynthesisVendor = this.synthesizer.fallbackVendor !== 'default'
        ? this.synthesizer.fallbackVendor
        : cs.fallbackSpeechSynthesisVendor;
      cs.fallbackSpeechSynthesisLabel = this.synthesizer.fallbackLabel !== 'default'
        ? this.synthesizer.fallbackLabel
        : cs.fallbackSpeechSynthesisLabel;
      cs.fallbackSpeechSynthesisLanguage = this.synthesizer.fallbackLanguage !== 'default'
        ?  this.synthesizer.fallbackLanguage
        : cs.fallbackSpeechSynthesisLanguage;
      cs.fallbackSpeechSynthesisVoice = this.synthesizer.fallbackVoice !== 'default'
        ? this.synthesizer.fallbackVoice
        : cs.fallbackSpeechSynthesisVoice;
      this.logger.info({synthesizer: this.synthesizer}, 'Config: updated synthesizer');
    }
    if (this.hasRecognizer) {
      cs.recognizer = this.recognizer;
      cs.speechRecognizerVendor = this.recognizer.vendor !== 'default'
        ? this.recognizer.vendor
        : cs.speechRecognizerVendor;
      cs.speechRecognizerLabel = this.recognizer.label !== 'default'
        ? this.recognizer.label
        : cs.speechRecognizerLabel;
      cs.speechRecognizerLanguage = this.recognizer.language !== 'default'
        ? this.recognizer.language
        : cs.speechRecognizerLanguage;

      //fallback
      cs.fallbackSpeechRecognizerVendor = this.recognizer.fallbackVendor !== 'default'
        ? this.recognizer.fallbackVendor
        : cs.fallbackSpeechRecognizerVendor;
      cs.fallbackSpeechRecognizerLabel = this.recognizer.fallbackLabel !== 'default'
        ? this.recognizer.fallbackLabel
        : cs.fallbackSpeechRecognizerLabel;
      cs.fallbackSpeechRecognizerLanguage = this.recognizer.fallbackLanguage !== 'default'
        ? this.recognizer.fallbackLanguage
        : cs.fallbackSpeechRecognizerLanguage;

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
        cs.startBackgroundTask('listen', {verb: 'listen', ...opts});
      } else {
        this.logger.info('Config: disabling listen');
        cs.stopBackgroundTask('listen');
      }
    }
    if (this.hasTranscribe) {
      if (this.transcribe.enable) {
        this.transcribeOpts.recognizer = this.hasRecognizer ?
          this.recognizer :
          {
            vendor: cs.speechRecognizerVendor,
            language: cs.speechRecognizerLanguage
          };
        this.logger.debug(this.transcribeOpts, 'Config: enabling transcribe');
        cs.startBackgroundTask('transcribe', this.transcribeOpts);
      } else {
        this.logger.info('Config: disabling transcribe');
        cs.stopBackgroundTask('transcribe');
      }
    }
    if (Object.keys(this.actionHookDelayAction).length !== 0) {
      cs.actionHookDelayProperties = this.actionHookDelayAction;
    }
    if (this.data.sipRequestWithinDialogHook) {
      cs.sipRequestWithinDialogHook = this.data.sipRequestWithinDialogHook;
    }

    if ('boostAudioSignal' in this.data) {
      const db = parseDecibels(this.data.boostAudioSignal);
      this.logger.info(`Config: boosting audio signal by ${db} dB`);
      const args = [ep.uuid, 'setGain', db];
      ep.api('uuid_dub', args).catch((err) => {
        this.logger.error(err, 'Error boosting audio signal');
      });
    }

    if (this.hasFillerNoise) {
      const {enable, ...opts} = this.fillerNoise;
      this.logger.info({fillerNoise: this.fillerNoise}, 'Config: fillerNoise');
      if (!enable) cs.disableFillerNoise();
      else {
        cs.enableFillerNoise(opts);
      }
    }

    if (this.hasVad) {
      cs.vad = {
        enable: this.vad.enable || false,
        voiceMs: this.vad.voiceMs || 250,
        silenceMs: this.vad.silenceMs || 150,
        strategy: this.vad.strategy || 'one-shot',
        mode: this.vad.mod || 2
      };
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
