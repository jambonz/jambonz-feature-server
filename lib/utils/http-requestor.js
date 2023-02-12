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

    assert(this._isAbsoluteUrl(this.url));
    assert(['GET', 'POST'].includes(this.method));

    const u = this._parsedUrl = parseUrl(this.url);
    if (u.port) this._baseUrl = `${u.protocol}://${u.resource}:${u.port}`;
    else this._baseUrl = `${u.protocol}://${u.resource}`;
    this._protocol = u.protocol;
    this._resource = u.resource;
    this._port = u.port;
    this._search = u.search;
    this._usePools = process.env.HTTP_POOL && parseInt(process.env.HTTP_POOL);

    if (this._usePools) {
      if (pools.has(this._baseUrl)) {
        this.client = pools.get(this._baseUrl);
      }
      else {
        const connections = process.env.HTTP_POOLSIZE ? parseInt(process.env.HTTP_POOLSIZE) : 10;
        const pipelining = process.env.HTTP_PIPELINING ? parseInt(process.env.HTTP_PIPELINING) : 1;
        const pool = this.client = new Pool(this._baseUrl, {
          connections,
          pipelining
        });
        pools.set(this._baseUrl, pool);
        this.logger.debug(`HttpRequestor:created pool for ${this._baseUrl}`);
      }
    }
    else {
      if (u.port) this.client = new Client(`${u.protocol}://${u.resource}:${u.port}`);
      else this.client = new Client(`${u.protocol}://${u.resource}`);
    }
  }

  get baseUrl() {
    return this._baseUrl;
  }

  close() {
    if (!this._usePools && !this.client?.closed) this.client.close();
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
    const startAt = process.hrtime();

    /* if we have an absolute url, and it is ws then do a websocket connection */
    if (this._isAbsoluteUrl(url) && url.startsWith('ws')) {
      const WsRequestor = require('./ws-requestor');
      this.logger.debug({hook}, 'HttpRequestor: switching to websocket connection');
      const h = typeof hook === 'object' ? hook : {url: hook};
      const requestor = new WsRequestor(this.logger, this.account_sid, h, this.secret);
      if (type === 'session:redirect') {
        this.close();
        this.emit('handover', requestor);
      }
      return requestor.request('session:new', hook, params, httpHeaders);
    }

    let newClient;
    try {
      let client, path, query;
      if (this._isRelativeUrl(url)) {
        client = this.client;
        path = url;
      }
      else {
        const u = parseUrl(url);
        if (u.resource === this._resource && u.port === this._port && u.protocol === this._protocol) {
          client = this.client;
          path = u.pathname;
          query = u.query;
        }
        else {
          if (u.port) client = newClient = new Client(`${u.protocol}://${u.resource}:${u.port}`);
          else client = newClient = new Client(`${u.protocol}://${u.resource}`);
          path = u.pathname;
          query = u.query;
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
      const {statusCode, headers, body} =  await client.request({
        path,
        query,
        method,
        headers: hdrs,
        ...('POST' === method && {body: JSON.stringify(payload)}),
        timeout: HTTP_TIMEOUT,
        followRedirects: false
      });
      if (![200, 202, 204].includes(statusCode)) {
        const err = new Error();
        err.statusCode = statusCode;
        throw err;
      }
      if (headers['content-type']?.includes('application/json')) {
        buf = await body.json();
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

    if (buf && Array.isArray(buf)) {
      this.logger.info({response: buf}, `HttpRequestor:request ${method} ${url} succeeded in ${rtt}ms`);
      return buf;
    }
  }
}

module.exports = HttpRequestor;
