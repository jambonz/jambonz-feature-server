const {Client, Pool} = require('undici');
const parseUrl = require('parse-url');
const assert = require('assert');
const BaseRequestor = require('./base-requestor');
const {HookMsgTypes} = require('./constants.json');
const snakeCaseKeys = require('./snakecase-keys');
const pools = new Map();
const HTTP_TIMEOUT = 10000;

const toBase64 = (str) => Buffer.from(str || '', 'utf8').toString('base64');

function basicAuth(username, password) {
  if (!username || !password) return {};
  const creds = `${username}:${password || ''}`;
  const header = `Basic ${toBase64(creds)}`;
  return {Authorization: header};
}


class HttpRequestor extends BaseRequestor {
  constructor(logger, account_sid, hook, secret) {
    super(logger, account_sid, hook, secret);

    this.method = hook.method || 'POST';
    this.authHeader = basicAuth(hook.username, hook.password);

    const u = this._parsedUrl = parseUrl(this.url);
    this._baseUrl = `${u.protocol}://${u.resource}`;
    this._resource = u.resource;
    this._protocol = u.protocol;

    if (process.env.HTTP_POOL) {
      if (pools.has(this._baseUrl)) {
        this.client = pools.get(this._baseUrl);
      }
      else {
        const pool = this.client = new Pool(this._baseUrl, {
          connections: process.env.HTTP_POOLSIZE || 10,
        });
        pools.set(this._baseUrl, pool);
      }
      this._pool = pools.get(process.env.HTTP_POOL);
    }
    else this.client = new Client(`${u.protocol}://${u.resource}`);

    assert(this._isAbsoluteUrl(this.url));
    assert(['GET', 'POST'].includes(this.method));
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
  async request(type, hook, params, httpHeaders = {}) {
    /* jambonz:error only sent over ws */
    if (type === 'jambonz:error') return;

    assert(HookMsgTypes.includes(type));

    const payload = params ? snakeCaseKeys(params, ['customerData', 'sip']) : null;
    const url = hook.url || hook;
    const method = hook.method || 'POST';
    let buf = '';

    assert.ok(url, 'HttpRequestor:request url was not provided');
    assert.ok, (['GET', 'POST'].includes(method), `HttpRequestor:request method must be 'GET' or 'POST' not ${method}`);
    const {url: urlInfo = hook, method: methodInfo = 'POST'} = hook;  // mask user/pass
    this.logger.debug({url: urlInfo, method: methodInfo, payload}, `HttpRequestor:request ${method} ${url}`);
    const startAt = process.hrtime();

    let newClient;
    try {
      let client, path;
      if (this._isRelativeUrl(url)) {
        client = this.client;
        path = url;
      }
      else {
        const u = parseUrl(url);
        if (u.resource === this._resource && u.protocol === this._protocol) {
          client = this.client;
          path = u.pathname;
        }
        else {
          client = newClient = new Client(`${u.protocol}://${u.resource}`);
          path = u.pathname;
        }
      }
      const sigHeader = this._generateSigHeader(payload, this.secret);
      const hdrs = {
        ...sigHeader,
        ...this.authHeader,
        ...httpHeaders,
        ...('POST' === method && {'Content-Type': 'application/json'})
      };
      const absUrl = this._isRelativeUrl(url) ? `${this.baseUrl}${url}` : url;
      this.logger.debug({url, absUrl, hdrs}, 'send webhook');
      const {statusCode, body} =  await client.request({
        path,
        method,
        headers: hdrs,
        ...('POST' === method && {body: JSON.stringify(payload)}),
        timeout: HTTP_TIMEOUT,
        followRedirects: false
      });
      if (![200, 202, 204].includes(statusCode)) throw new Error({statusCode});
      body.setEncoding('utf8');
      for await (const chunk of body) {
        buf += chunk;
      }
      if (newClient) newClient.close();
    } catch (err) {
      if (err.statusCode) {
        this.logger.info({baseUrl: this.baseUrl, url},
          `web callback returned unexpected status code ${err.statusCode}`);
      }
      else {
        this.logger.error({err, baseUrl: this.baseUrl, url},
          'web callback returned unexpected error');
      }
      let opts = {account_sid: this.account_sid};
      if (err.code === 'ECONNREFUSED') {
        opts = {...opts, alert_type: this.Alerter.AlertType.WEBHOOK_CONNECTION_FAILURE, url};
      }
      else if (err.name === 'StatusError') {
        opts = {...opts, alert_type: this.Alerter.AlertType.WEBHOOK_STATUS_FAILURE, url, status: err.statusCode};
      }
      else {
        opts = {...opts, alert_type: this.Alerter.AlertType.WEBHOOK_CONNECTION_FAILURE, url, detail: err.message};
      }
      this.Alerter.writeAlerts(opts).catch((err) => this.logger.info({err, opts}, 'Error writing alert'));

      if (newClient) newClient.close();
      throw err;
    }
    const rtt = this._roundTrip(startAt);
    if (buf) this.stats.histogram('app.hook.response_time', rtt, ['hook_type:app']);

    if (buf && buf.length > 0) {
      try {
        const json = JSON.parse(buf);
        this.logger.info({response: json}, `HttpRequestor:request ${method} ${url} succeeded in ${rtt}ms`);
        return json;
      }
      catch (err) {
        //this.logger.debug({err, url, method}, `HttpRequestor:request returned non-JSON content: '${buf.toString()}'`);
      }
    }
  }
}

module.exports = HttpRequestor;
