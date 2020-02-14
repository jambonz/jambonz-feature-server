class DtmfEntry {
  constructor(key, time) {
    this.key = key;
    this.time = time;
  }
}

/**
 * @classdesc Represents an object that collects dtmf key entries and
 * reports when a match is detected
 */
class DtmfCollector {
  constructor({logger, patterns, interDigitTimeout}) {
    this.logger = logger;
    this.patterns = patterns;
    this.idt = interDigitTimeout || 3000;
    this.buffer = [];
  }

  keyPress(key) {
    const now = Date.now();

    // age out previous entries if interdigit timer has elapsed
    const lastDtmf = this.buffer.pop();
    if (lastDtmf) {
      if (now - lastDtmf.time < this.idt) this.buffer.push(lastDtmf);
      else {
        this.buffer = [];
      }
    }
    // add new entry
    this.buffer.push(new DtmfEntry(key, now));

    // check for a match
    const collectedDigits = this.buffer
      .map((entry) => entry.key)
      .join('');
    return this.patterns.find((pattern) => collectedDigits.endsWith(pattern));
  }
}

module.exports = DtmfCollector;
