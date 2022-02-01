const Emitter = require('events');

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
    this.turnConfig = opts.nextTurn || {};
    this.update(opts);
  }

  update(opts = {}) {
    const {session, nextTurn = {}} = opts;
    if (session) this.sessionConfig = {...this.sessionConfig, ...session};
    this.turnConfig = nextTurn;
    this.logger.debug({opts, sessionLevel: this.sessionConfig, turnLevel: this.turnConfig}, 'SpeechConfig updated');
  }

  makeGatherTaskConfig({textPrompt, urlPrompt} = {}) {
    const opts = JSON.parse(JSON.stringify(this.sessionConfig || {}));
    const nextTurnKeys = Object.keys(this.turnConfig || {});
    const newKeys = nextTurnKeys.filter((k) => !(k in opts));
    const bothKeys = nextTurnKeys.filter((k) => k in opts);

    for (const key of newKeys) opts[key] = this.turnConfig[key];
    for (const key of bothKeys) opts[key] = {...opts[key], ...this.turnConfig[key]};

    this.logger.debug({
      opts,
      sessionConfig: this.sessionConfig,
      turnConfig: this.turnConfig,
    }, 'Congigy SpeechConfig:_makeGatherTask current options');

    /* input type: speech and/or dtmf entry */
    const input = [];
    if (opts.recognizer) input.push('speech');
    if (hasKeys(opts.dtmf)) input.push('digits');

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
      }
    };

    const final = stripNulls(config);

    /* turn config can now be emptied for next turn of conversation */
    this.turnConfig = {};

    const config = {};
    if(sayConfig){
      config.say = sayConfig;
    }else if(playConfig){
      config.play = playConfig;
    }
    return textPrompt ?
      {...final, say: sayConfig} :
      {...final, play: playConfig};
  }
}

module.exports = SpeechConfig;
