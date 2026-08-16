const assert = require('assert');
const Emitter = require('events');
const crypto = require('crypto');
const parseUrl = require('parse-url');
const timeSeries = require('@jambonz/time-series');
const {NODE_ENV, JAMBONES_TIME_SERIES_HOST} = require('../config');
let alerter ;

// The ws (v8) library throws this plain Error on an opening-handshake timeout. It carries no
// .code and .name === 'Error', so it must be matched by message to be treated as a connection
// timeout (ct) for retry purposes (issue #1565).
const WS_HANDSHAKE_TIMEOUT_MESSAGE = 'Opening handshake has timed out';

class BaseRequestor extends Emitter {
  constructor(logger, account_sid, hook, secret) {
    super();
    assert(typeof hook === 'object');

    this.logger = logger;
    this.url = hook.url;

    this.username = hook.username;
    this.password = hook.password;
    this.secret = secret;
    this.account_sid = account_sid;

    const {stats} = require('../../').srf.locals;
    this.stats = stats;

    const u = this._parsedUrl = parseUrl(this.url);
    if (u.port) this._baseUrl = `${u.protocol}://${u.resource}:${u.port}`;
    else this._baseUrl = `${u.protocol}://${u.resource}`;

    if (!alerter) {
      alerter = timeSeries(logger, {
        host: JAMBONES_TIME_SERIES_HOST,
        commitSize: 50,
        commitInterval: 'test' === NODE_ENV ? 7 : 20
      });
    }
  }

  get baseUrl() {
    return this._baseUrl;
  }

  get Alerter() {
    return alerter;
  }

  close() {
    /* subclass responsibility */
  }

  _computeSignature(payload, timestamp, secret) {
    assert(secret);
    const data = `${timestamp}.${JSON.stringify(payload)}`;
    return crypto
      .createHmac('sha256', secret)
      .update(data, 'utf8')
      .digest('hex');
  }

  _generateSigHeader(payload, secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = this._computeSignature(payload, timestamp, secret);
    const scheme = 'v1';
    return {
      'Jambonz-Signature': `t=${timestamp},${scheme}=${signature}`
    };
  }

  _isAbsoluteUrl(u) {
    return typeof u === 'string' &&
      u.startsWith('https://') || u.startsWith('http://') ||
      u.startsWith('ws://') || u.startsWith('wss://');
  }
  _isRelativeUrl(u) {
    return typeof u === 'string' && u.startsWith('/');
  }
  _roundTrip(startAt) {
    const diff = process.hrtime(startAt);
    const time = diff[0] * 1e3 + diff[1] * 1e-6;
    return time.toFixed(0);
  }

  _parseHashParams(hash) {
    // Remove the leading # if present
    const hashString = hash.startsWith('#') ? hash.substring(1) : hash;
    // Use URLSearchParams for parsing
    const params = new URLSearchParams(hashString);
    // Convert to a regular object
    const result = {};
    for (const [key, value] of params.entries()) {
      result[key] = value;
    }
    return result;
  }

  /**
   * Check if the error should be retried based on retry policy
   * @param {Error} err - The error that occurred
   * @param {string[]} rpValues - Array of retry policy values
   * @returns {boolean} True if the error should be retried
   */
  _shouldRetry(err, rpValues) {
    // ct = connection timeout (ECONNREFUSED, ETIMEDOUT, etc). The ws opening-handshake timeout
    // has no .code, so match it by message so the default ct policy retries it (issue #1565).
    const isCt = err.code === 'ECONNREFUSED' ||
                 err.code === 'ETIMEDOUT' ||
                 err.code === 'ECONNRESET' ||
                 err.code === 'ECONNABORTED' ||
                 err.message === WS_HANDSHAKE_TIMEOUT_MESSAGE;
    // rt = request timeout
    const isRt = err.name === 'TimeoutError';
    // 4xx = client errors
    const is4xx = err.statusCode >= 400 && err.statusCode < 500;
    // 5xx = server errors
    const is5xx = err.statusCode >= 500 && err.statusCode < 600;
    // Check if error type is included in retry policy
    return rpValues.includes('all') ||
           (isCt && rpValues.includes('ct')) ||
           (isRt && rpValues.includes('rt')) ||
           (is4xx && rpValues.includes('4xx')) ||
           (is5xx && rpValues.includes('5xx'));
  }
}

module.exports = BaseRequestor;
