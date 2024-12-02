class NonFatalTaskError extends Error {
  constructor(msg) {
    super(msg);
  }
}

class SpeechCredentialError extends NonFatalTaskError {
  constructor(msg) {
    super(msg);
  }
}

module.exports = {
  SpeechCredentialError,
  NonFatalTaskError
};
