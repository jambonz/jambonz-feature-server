class SpeechCredentialError extends Error {
  constructor(msg) {
    super(msg);
  }
}

class NonFatalTaskError extends Error {
  constructor(msg) {
    super(msg);
  }
}

module.exports = {
  SpeechCredentialError,
  NonFatalTaskError
};
