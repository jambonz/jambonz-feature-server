const Emitter = require('events');

/**
 * A dtmf collector
 * @class
 */
class DigitBuffer extends Emitter {
  /**
   * Creates a DigitBuffer
   * @param {*} logger - a pino logger
   * @param {*} opts - dtmf collection instructions
   */
  constructor(logger, opts) {
    super();
    this.logger = logger;
    this.minDigits = opts.min || 1;
    this.maxDigits = opts.max || 99;
    this.termDigit = opts.term;
    this.interdigitTimeout = opts.idt || 8000;
    this.template = opts.template;
    this.buffer = '';
    this.logger.debug(`digitbuffer min: ${this.minDigits} max: ${this.maxDigits} term digit: ${this.termDigit}`);
  }

  /**
   * process a received dtmf digit
   * @param {String} a single digit entered by the caller
   */
  process(digit) {
    this.logger.debug(`digitbuffer process: ${digit}`);
    if (digit === this.termDigit) return this._fulfill();
    this.buffer += digit;
    if (this.buffer.length === this.maxDigits) return this._fulfill();
    if (this.buffer.length >= this.minDigits) this._startInterDigitTimer();
    this.logger.debug(`digitbuffer buffer: ${this.buffer}`);
  }

  /**
   * clear the digit buffer
   */
  flush() {
    if (this.idtimer) clearTimeout(this.idtimer);
    this.buffer = '';
  }

  _fulfill() {
    this.logger.debug(`digit buffer fulfilled with ${this.buffer}`);
    if (this.template && this.template.includes('${digits}')) {
      const text = this.template.replace('${digits}', this.buffer);
      this.logger.info(`reporting dtmf as ${text}`);
      this.emit('fulfilled', text);
    }
    else {
      this.emit('fulfilled', this.buffer);
    }
    this.flush();
  }

  _startInterDigitTimer() {
    if (this.idtimer) clearTimeout(this.idtimer);
    this.idtimer = setTimeout(this._onInterDigitTimeout.bind(this), this.interdigitTimeout);
  }

  _onInterDigitTimeout() {
    this.logger.debug('digit buffer timeout');
    this._fulfill();
  }
}

module.exports = DigitBuffer;
