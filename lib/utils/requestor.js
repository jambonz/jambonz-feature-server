const bent = require('bent');
const parseUrl = require('parse-url');
const assert = require('assert');
const snakeCaseKeys = require('./snakecase-keys');
const crypto = require('crypto');
const timeSeries = require('@jambonz/time-series');
let alerter ;

const toBase64 = (str) => Buffer.from(str || '', 'utf8').toString('base64');

function computeSignature(payload, timestamp, secret) {
  assert(secret);
  const data = `${timestamp}.${JSON.stringify(payload)}`;
  return crypto
    .createHmac('sha256', secret)
    .update(data, 'utf8')
    .digest('hex');
}

function generateSigHeader(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = computeSignature(payload, timestamp, secret);
  const scheme = 'v1';
  return {
    'Jambonz-Signature': `t=${timestamp},${scheme}=${signature}`
  };
}

function basicAuth(username, password) {
  if (!username || !password) return {};
  const creds = `${username}:${password || ''}`;
  const header = `Basic ${toBase64(creds)}`;
  return {Authorization: header};
}

function isRelativeUrl(u) {
  return typeof u === 'string' && u.startsWith('/');
}

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
    this.authHeader = basicAuth(hook.username, hook.password);

    const u = parseUrl(this.url);
    const myPort = u.port ? `:${u.port}` : '';
    const baseUrl = this._baseUrl = `${u.protocol}://${u.resource}${myPort}`;

    this.get = bent(baseUrl, 'GET', 'buffer', 200, 201);
    this.post = bent(baseUrl, 'POST', 'buffer', 200, 201);

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

  get baseUrl() {
    return this._baseUrl;
  }

  /**
   * Make an HTTP request.
   * All requests use json bodies.
   * All requests expect a 200 statusCode on success
   * @param {object|string} hook - may be a absolute or relative url, or an object
   * @param {string} [hook.url] - an absolute or relative url
   * @param {string} [hook.method] - 'GET' or 'POST'
   * @param {string} [hook.username] - if basic auth is protecting the endpoint
   * @param {string} [hook.password] - if basic auth is protecting the endpoint
   * @param {object} [params] - request parameters
   */
  async request(hook, params) {
    const payload = params ? snakeCaseKeys(params, ['customerData', 'sip']) : null;
    const url = hook.url || hook;
    const method = hook.method || 'POST';

    assert.ok(url, 'Requestor:request url was not provided');
    assert.ok, (['GET', 'POST'].includes(method), `Requestor:request method must be 'GET' or 'POST' not ${method}`);

    this.logger.debug({hook, payload}, `Requestor:request ${method} ${url}`);
    const startAt = process.hrtime();

    let buf;
    try {
      const sigHeader = generateSigHeader(payload, this.secret);
      const headers = {...sigHeader, ...this.authHeader};
      this.logger.info({url, headers}, 'send webhook');
      buf = isRelativeUrl(url) ?
        await this.post(url, payload, headers) :
        await bent(method, 'buffer', 200, 201, 202)(url, payload, headers);
    } catch (err) {
      this.logger.error({err, secret: this.secret, baseUrl: this.baseUrl, url, statusCode: err.statusCode},
        `web callback returned unexpected error code ${err.statusCode}`);
      let opts = {account_sid: this.account_sid};
      if (err.code === 'ECONNREFUSED') {
        opts = {...opts, alert_type: alerter.AlertType.WEBHOOK_CONNECTION_FAILURE, url};
      }
      else if (err.name === 'StatusError') {
        opts = {...opts, alert_type: alerter.AlertType.WEBHOOK_STATUS_FAILURE, url, status: err.statusCode};
      }
      else {
        opts = {...opts, alert_type: alerter.AlertType.WEBHOOK_CONNECTION_FAILURE, url, detail: err.message};
      }
      alerter.writeAlerts(opts).catch((err) => this.logger.info({err, opts}, 'Error writing alert'));

      throw err;
    }
    const diff = process.hrtime(startAt);
    const time = diff[0] * 1e3 + diff[1] * 1e-6;
    const rtt = time.toFixed(0);
    if (buf) this.stats.histogram('app.hook.response_time', rtt, ['hook_type:app']);

    if (buf && buf.toString().length > 0) {
      try {
        const json = JSON.parse(buf.toString());
        this.logger.info({response: json}, `Requestor:request ${method} ${url} succeeded in ${rtt}ms`);
        return json;
      }
      catch (err) {
        //this.logger.debug({err, url, method}, `Requestor:request returned non-JSON content: '${buf.toString()}'`);
      }
    }
  }
}

module.exports = Requestor;
