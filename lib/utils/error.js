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

class HTTPResponseError extends Error {
  constructor(statusCode) {
    super('Unexpected HTTP Response');
    delete this.stack;
    this.statusCode = statusCode;
  }
}

module.exports = {
  SpeechCredentialError,
  NonFatalTaskError,
  PlayFileNotFoundError,
  HTTPResponseError
};
