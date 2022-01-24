const Emitter = require('events');

const hasKeys = (obj) => typeof obj === 'object' && Object.keys(obj) > 0;

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

  makeGatherTaskConfig(prompt) {
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
    const minBargeinWordCount = speechBargein ? (bargein.minWordCount || 1) : 0;
    const sayConfig = {
      text: prompt,
      synthesizer: opts.synthesizer
    };
    const config = {
      input,
      listenDuringPrompt: speechBargein,
      bargein: speechBargein,
      minBargeinWordCount,
      recognizer: opts?.recognizer,
      timeout: opts?.user?.noInputTimeout || 0,
      say: sayConfig
    };

    this.logger.debug({config}, 'Congigy SpeechConfig:_makeGatherTask config');

    /* turn config can now be emptied for next turn of conversation */
    this.turnConfig = {};
    return config;
  }
}

module.exports = SpeechConfig;
