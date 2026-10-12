/**
 * Collects caller DTMF into whole entries for vendors that take keypad input as text.
 * Options and termination rules follow the gather verb (seconds; timeout 15 by default, 0 = off).
 */
const DEFAULT_TIMEOUT = 15;

const seconds = (v) => (typeof v === 'number' && v >= 0 ? v : undefined);

class DtmfInput {
  /**
   * @param {object} logger - a pino logger
   * @param {object} opts - gather-style dtmf options
   * @param {object} handlers - onKey(digit) for every key press, onEntry(digits) for each completed entry
   */
  constructor(logger, opts = {}, {onKey, onEntry}) {
    this.logger = logger;
    this.finishOnKey = opts.finishOnKey;
    this.numDigits = opts.numDigits;
    this.maxDigits = opts.maxDigits;
    // gather never arms its inter-digit timer when minDigits is unset; 1 makes interDigitTimeout work on its own
    this.minDigits = opts.minDigits || 1;
    this.interDigitTimeout = (seconds(opts.interDigitTimeout) || 0) * 1000;
    const timeout = seconds(opts.timeout);
    this.timeout = (timeout === undefined ? DEFAULT_TIMEOUT : timeout) * 1000;
    this.onKey = onKey;
    this.onEntry = onEntry;
    this.buffer = '';
  }

  start(ep) {
    if (this._onDtmf) return;
    this.ep = ep;
    this._onDtmf = (evt) => this.process(evt.dtmf);
    ep.on('dtmf', this._onDtmf);
  }

  stop() {
    if (this._onDtmf) this.ep.removeListener('dtmf', this._onDtmf);
    this._onDtmf = null;
    this._clearTimers();
    if (this.buffer) this.logger.info({digits: this.buffer}, 'DtmfInput: discarding an incomplete entry');
    this.buffer = '';
  }

  process(digit) {
    this.onKey?.(digit);
    clearTimeout(this.interDigitTimer);
    if (!this.timer && this.timeout > 0) {
      this.timer = setTimeout(this._onTimeout.bind(this), this.timeout);
    }
    if (digit === this.finishOnKey) return this._complete();

    this.buffer += digit;
    const len = this.buffer.length;
    if (len === this.numDigits || len === this.maxDigits) return this._complete();
    if (this.interDigitTimeout > 0 && len >= this.minDigits) {
      this.interDigitTimer = setTimeout(this._complete.bind(this), this.interDigitTimeout);
    }
  }

  _onTimeout() {
    if (this.buffer.length < this.minDigits) {
      this.logger.info({digits: this.buffer}, 'DtmfInput: timeout before minDigits, discarding entry');
      this._clearTimers();
      this.buffer = '';
      return;
    }
    this._complete();
  }

  _complete() {
    this._clearTimers();
    const digits = this.buffer;
    this.buffer = '';
    if (digits) this.onEntry(digits);
  }

  _clearTimers() {
    clearTimeout(this.interDigitTimer);
    clearTimeout(this.timer);
    this.interDigitTimer = this.timer = null;
  }
}

module.exports = DtmfInput;
