const {request, getGlobalDispatcher, setGlobalDispatcher, Dispatcher, ProxyAgent, Client, Pool} = require('undici');
const parseUrl = require('parse-url');
const assert = require('assert');
const BaseRequestor = require('./base-requestor');
const {HookMsgTypes} = require('./constants.json');
const snakeCaseKeys = require('./snakecase-keys');
const pools = new Map();
const {
  HTTP_POOL,
  HTTP_POOLSIZE,
  HTTP_PIPELINING,
  HTTP_TIMEOUT,
  HTTP_PROXY_IP,
  HTTP_PROXY_PORT,
  HTTP_PROXY_PROTOCOL,
  NODE_ENV,
  HTTP_USER_AGENT_HEADER,
} = require('../config');
const {HTTPResponseError} = require('./error');

const toBase64 = (str) => Buffer.from(str || '', 'utf8').toString('base64');

function basicAuth(username, password) {
  if (!username || !password) return {};
  const creds = `${username}:${password || ''}`;
  const header = `Basic ${toBase64(creds)}`;
  return {Authorization: header};
}

const defaultDispatcher = HTTP_PROXY_IP ?
  new ProxyAgent(`${HTTP_PROXY_PROTOCOL}://${HTTP_PROXY_IP}${HTTP_PROXY_PORT ? `:${HTTP_PROXY_PORT}` : ''}`) :
  getGlobalDispatcher();

setGlobalDispatcher(new class extends Dispatcher {
  dispatch(options, handler) {
    return defaultDispatcher.dispatch(options, handler);
  }
}());

class HttpRequestor extends BaseRequestor {
  constructor(logger, account_sid, hook, secret) {
    super(logger, account_sid, hook, secret);

    this.method = hook.method?.toUpperCase() || 'POST';
    this.authHeader = basicAuth(hook.username, hook.password);
    this.backoffMs = 500;

    assert(this._isAbsoluteUrl(this.url));
    assert(['GET', 'POST'].includes(this.method));

    const u = this._parsedUrl = parseUrl(this.url);
    this._protocol = u.protocol;
    this._resource = u.resource;
    this._port = u.port;
    this._search = u.search;
    this._usePools = HTTP_POOL && parseInt(HTTP_POOL);

    if (this._usePools) {
      if (pools.has(this.baseUrl)) {
        this.client = pools.get(this.baseUrl);
      }
      else {
        const connections = HTTP_POOLSIZE ? parseInt(HTTP_POOLSIZE) : 10;
        const pipelining = HTTP_PIPELINING ? parseInt(HTTP_PIPELINING) : 1;
        const pool = this.client = new Pool(this.baseUrl, {
          connections,
          pipelining
        });
        pools.set(this.baseUrl, pool);
        this.logger.debug(`HttpRequestor:created pool for ${this.baseUrl}`);
      }
    }
    else {
      if (u.port) this.client = new Client(`${u.protocol}://${u.resource}:${u.port}`);
      else this.client = new Client(`${u.protocol}://${u.resource}`);
    }

    if (NODE_ENV == 'test' && process.env.JAMBONES_HTTP_PROXY_IP) {
      const defDispatcher =
        new ProxyAgent(`${process.env.JAMBONES_HTTP_PROXY_PROTOCOL}://${process.env.JAMBONES_HTTP_PROXY_IP}${
          process.env.JAMBONES_HTTP_PROXY_PORT ? `:${process.env.JAMBONES_HTTP_PROXY_PORT}` : ''}`);

      setGlobalDispatcher(new class extends Dispatcher {
        dispatch(options, handler) {
          return defDispatcher.dispatch(options, handler);
        }
      }());
    }
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
  async request(type, hook, params, httpHeaders = {}, span) {
    /* jambonz:error only sent over ws */
    if (type === 'jambonz:error') return;

    assert(HookMsgTypes.includes(type));

    const payload = params ? snakeCaseKeys(params, ['customerData', 'sip', 'env_vars', 'args']) : null;
    const url = hook.url || hook;
    const method = hook.method?.toUpperCase() || 'POST';
    let buf = '';
    httpHeaders = {
      ...httpHeaders,
      ...(HTTP_USER_AGENT_HEADER && {'user-agent' : HTTP_USER_AGENT_HEADER})
    };

    assert.ok(url, 'HttpRequestor:request url was not provided');
    assert.ok(['GET', 'POST'].includes(method), `HttpRequestor:request method must be 'GET' or 'POST' not ${method}`);
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
      return requestor.request('session:new', hook, params, httpHeaders, span);
    }

    let newClient;
    try {
      this.backoffMs = 500;
      // Parse URL and extract hash parameters for retry configuration
      // Prepare request options - only do this once
      const absUrl = this._isRelativeUrl(url) ? `${this.baseUrl}${url}` : url;
      const parsedUrl = parseUrl(absUrl);
      const hash = parsedUrl.hash || '';
      const hashObj = hash ? this._parseHashParams(hash) : {};

      // Retry policy: rp valid values: 4xx, 5xx, ct, rt, all, default is ct
      // Retry count: rc valid values: 1-5, default is 0
      // rc is the number of attempts we'll make AFTER the initial try
      const rc = hash ? Math.min(Math.abs(parseInt(hashObj.rc || '0')), 5) : 0;
      const rp = hashObj.rp || 'ct';
      const rpValues = rp.split(',').map((v) => v.trim());
      let retryCount = 0;

      // Set up client, path and query parameters - only do this once
      let client, path, query;
      if (this._isRelativeUrl(url)) {
        client = this.client;
        path = url;
      }
      else {
        if (parsedUrl.resource === this._resource &&
          parsedUrl.port === this._port &&
          parsedUrl.protocol === this._protocol) {
          client = this.client;
          path = parsedUrl.pathname;
          query = parsedUrl.query;
        }
        else {
          if (parsedUrl.port) {
            client = newClient = new Client(`${parsedUrl.protocol}://${parsedUrl.resource}:${parsedUrl.port}`);
          }
          else client = newClient = new Client(`${parsedUrl.protocol}://${parsedUrl.resource}`);
          path = parsedUrl.pathname;
          query = parsedUrl.query;
        }
      }

      const sigHeader = this._generateSigHeader(payload, this.secret);
      const hdrs = {
        ...sigHeader,
        ...this.authHeader,
        ...httpHeaders,
        ...('POST' === method && {'Content-Type': 'application/json'})
      };

      const requestOptions = {
        path,
        query,
        method,
        headers: hdrs,
        ...('POST' === method && {body: JSON.stringify(payload)}),
        timeout: HTTP_TIMEOUT,
        followRedirects: false
      };

      // Simplified makeRequest function that just executes the HTTP request
      const makeRequest = async() => {
        this.logger.debug({url, absUrl, hdrs, retryCount},
          `send webhook${retryCount > 0 ? ' (retry ' + retryCount + ')' : ''}`);

        const {statusCode, headers, body} = HTTP_PROXY_IP ? await request(
          this.baseUrl,
          requestOptions
        ) : await client.request(requestOptions);

        if (![200, 202, 204].includes(statusCode)) {
          const err = new HTTPResponseError(statusCode);
          throw err;
        }

        if (headers['content-type']?.includes('application/json')) {
          return await body.json();
        }
        return '';
      };

      while (true) {
        try {
          buf = await makeRequest();
          break; // Success, exit the retry loop
        } catch (err) {
          retryCount++;

          // Check if we should retry
          if (retryCount <= rc && this._shouldRetry(err, rpValues)) {
            this.logger.info(
              {err, baseUrl: this.baseUrl, url, retryCount, maxRetries: rc},
              `Retrying request (${retryCount}/${rc})`
            );
            const delay = this.backoffMs;
            this.backoffMs = this.backoffMs < 2000 ? this.backoffMs * 2 : (this.backoffMs + 2000);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          throw err;
        }
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

    if (buf && (Array.isArray(buf) || type == 'llm:tool-call')) {
      this.logger.info({response: buf}, `HttpRequestor:request ${method} ${url} succeeded in ${rtt}ms`);
    }
    return buf;
  }
}

module.exports = HttpRequestor;
