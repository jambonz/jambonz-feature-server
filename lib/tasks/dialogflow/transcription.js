class Transcription {
  constructor(logger, evt) {
    this.logger = logger;

    this.recognition_result = evt.recognition_result;
  }

  get isEmpty() {
    return !this.recognition_result;
  }

  get isFinal() {
    return this.recognition_result && this.recognition_result.is_final === true;
  }

  get confidence() {
    if (!this.isEmpty) return this.recognition_result.confidence;
  }

  get text() {
    if (!this.isEmpty) return this.recognition_result.transcript;
  }

  startsWith(str) {
    return (this.text.toLowerCase() || '').startsWith(str.toLowerCase());
  }

  includes(str) {
    return (this.text.toLowerCase() || '').includes(str.toLowerCase());
  }

  toJSON() {
    return {
      final: this.recognition_result.is_final === true,
      text: this.text,
      confidence: this.confidence
    };
  }
}

module.exports = Transcription;
