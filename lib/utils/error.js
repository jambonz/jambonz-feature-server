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

class PlayFileNotFoundError extends NonFatalTaskError {
  constructor(url) {
    super('File not found');
    this.url = url;
  }
}

module.exports = {
  SpeechCredentialError,
  NonFatalTaskError,
  PlayFileNotFoundError
};
