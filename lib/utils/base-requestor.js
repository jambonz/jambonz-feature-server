const assert = require('assert');
const Emitter = require('events');
const crypto = require('crypto');
const timeSeries = require('@jambonz/time-series');
let alerter ;

class BaseRequestor extends Emitter {
  constructor(logger, service_provider_sid, account_sid, hook, secret) {
    super();
    assert(typeof hook === 'object');

    this.logger = logger;
    this.url = hook.url;

    this.username = hook.username;
    this.password = hook.password;
    this.secret = secret;
    this.service_provider_sid = service_provider_sid;
    this.account_sid = account_sid;

    const {stats} = require('../../').srf.locals;
    this.stats = stats;

    if (!alerter) {
      alerter = timeSeries(logger, {
        host: process.env.JAMBONES_TIME_SERIES_HOST,
        commitSize: 50,
        commitInterval: 'test' === process.env.NODE_ENV ? 7 : 20
      });
    }
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


}

module.exports = BaseRequestor;
