class SpeechFallbackError extends Error {
  constructor(msg) {
    super(msg);
  }
}

module.exports = {
  SpeechFallbackError
};
