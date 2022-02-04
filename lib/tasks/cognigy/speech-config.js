const obj = require('drachtio-fsmrf/lib/utils');
const Emitter = require('events');
const { isArray } = require('lodash');
const lodash = require('lodash');
const hasKeys = (obj) => typeof obj === 'object' && Object.keys(obj) > 0;

const stripNulls = (obj) => {
  Object.keys(obj).forEach((k) => (obj[k] === null || typeof obj[k] === 'undefined') && delete obj[k]);
  return obj;
};

class SpeechConfig extends Emitter {
  constructor({logger, ep, opts = {}}) {
    super();
    this.logger = logger;
    this.ep = ep;
    this.sessionConfig = opts.session || {};
    this.update(opts);
  }

  _mergeConfig(changedConfig = {}) {
    const merged = lodash.merge(
      this.sessionConfig,
      changedConfig,
      (objValue, sourceValue) => {
        if (Array.isArray(objValue)) {
          if (Array.isArray(sourceValue)) {
            return sourceValue;
          }
          return objValue;
        }
      }
    );
    this.logger.debug({merged, sessionConfig: this.sessionConfig, changedConfig}, 'merged config');
    // should we override hints with empty array or leave it as it is once saved?
    // merged.recognizer.hints = changedConfig.recognizer?.hints
    return merged;
  }

  update(session) {
    // TODO validation of session params?
    if (session) {
      this.sessionConfig = this._mergeConfig(session);
    }
    this.logger.debug({sessionLevel: this.sessionConfig}, 'SpeechConfig updated');
  }

  /**
   * check if we should skip all nodes until next bot input
   */
  get skipUntilBotInput() {
    return !this.sessionConfig.bargein?.skipUntilBotInput;
  }
  /**
   * Check if barge is enabled on session level
   */
  get bargeInEnabled() {
    return this.sessionConfig.bargein?.enable?.length > 0;
  }

  makeSayTaskConfig({text, turnConfig = {}} = {}) {
    const synthesizer = lodash.merge({}, this.sessionConfig.synthesizer, turnConfig.synthesizer);
    return {
      text,
      synthesizer
    };
  }

  makeGatherTaskConfig({textPrompt, urlPrompt, turnConfig = {}, listenAfterSpeech} = {}) {
    // we merge from top to bottom deeply so we wil have
    // defaults from session config and then will override them via turn config
    const opts = this._mergeConfig(turnConfig);

    this.logger.debug({
      opts,
      sessionConfig: this.sessionConfig,
      turnConfig
    }, 'Congigy SpeechConfig:_makeGatherTask current options');

    /* input type: speech and/or dtmf entry */
    const input = [];
    if (opts.recognizer) input.push('speech');
    if (hasKeys(opts.dtmf)) input.push('digits');

    if (opts.synthesizer) {
      // todo remove this once we add support for disabling tts cache
      delete opts.synthesizer.disableTtsCache;
    }

    /* bargein settings */
    const bargein = opts.bargein || {};
    const speechBargein = Array.isArray(bargein.enable) && bargein.enable.includes('speech');
    const dtmfBargein = Array.isArray(bargein.enable) && bargein.enable.includes('dtmf');
    const minBargeinWordCount = speechBargein ? (bargein.minWordCount || 1) : 0;
    const {interDigitTimeout = 0, maxDigits, minDigits = 1, submitDigit} = (opts.dtmf || {});
    const {noInputTimeout, noInputRetries, noInputSpeech, noInputUrl} = (opts.user || {});

    let sayConfig;
    let playConfig;

    if (textPrompt) {
      sayConfig = {
        text: textPrompt,
        synthesizer: opts.synthesizer
      };
    }

    // todo what is the logic here if we put both? play over say or say over play?
    if (urlPrompt) {
      playConfig = {
        url: urlPrompt
      };
    }

    const config = {
      input,
      listenDuringPrompt: speechBargein,
      bargein: speechBargein,
      minBargeinWordCount,
      dtmfBargein,
      minDigits,
      maxDigits,
      interDigitTimeout,
      finishOnKey: submitDigit,
      recognizer: opts?.recognizer,
      timeout: noInputTimeout,
      retry : {
        noInputRetries,
        noInputSpeech,
        noInputUrl
      },
      listenAfterSpeech
    };

    const final = stripNulls(config);

    const finalConfig = final;
    if (sayConfig) {
      finalConfig.say = sayConfig;
    } else if (playConfig) {
      finalConfig.play = playConfig;
    }
    this.logger.info({finalConfig}, 'created gather config');
    return finalConfig;
  }
}

module.exports = SpeechConfig;
