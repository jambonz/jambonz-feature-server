const assert = require('assert');
const timeSeries = require('@jambonz/time-series');
let alerter ;

function isAbsoluteUrl(u) {
  return typeof u === 'string' &&
    u.startsWith('https://') || u.startsWith('http://');
}

class Requestor {
  constructor(logger, account_sid, hook, secret) {
    assert(typeof hook === 'object');

    this.logger = logger;
    this.url = hook.url;
    this.method = hook.method || 'POST';

    this.username = hook.username;
    this.password = hook.password;
    this.secret = secret;
    this.account_sid = account_sid;

    assert(isAbsoluteUrl(this.url));
    assert(['GET', 'POST'].includes(this.method));

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
    if (!alerter) {
      alerter = timeSeries(this.logger, {
        host: process.env.JAMBONES_TIME_SERIES_HOST,
        commitSize: 50,
        commitInterval: 'test' === process.env.NODE_ENV ? 7 : 20
      });
    }
    return alerter;
  }
}

module.exports = Requestor;
