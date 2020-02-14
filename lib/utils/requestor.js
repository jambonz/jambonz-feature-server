const bent = require('bent');
const parseUrl = require('parse-url');
const basicAuth = require('./basic-auth');
const assert = require('assert');

function isRelativeUrl(u) {
  return typeof u === 'string' && u.startsWith('/');
}

function isAbsoluteUrl(u) {
  return typeof u === 'string' &&
    u.startsWith('https://') || u.startsWith('http://');
}

class Requestor {
  constructor(logger, hook) {
    this.logger = logger;
    this.url = hook.url;
    this.method = hook.method || 'POST';
    this.authHeader = basicAuth(hook.auth);

    const u = parseUrl(this.url);
    const myPort = u.port ? `:${u.port}` : '';
    const baseUrl = `${u.protocol}://${u.resource}${myPort}`;

    this.get = bent(baseUrl, 'GET', 'json', 200);
    this.post = bent(baseUrl, 'POST', 'json', 200);

    assert(isAbsoluteUrl(this.url));
    assert(['GET', 'POST'].includes(this.method));
    assert(!this.auth || typeof auth == 'object');
  }

  get hasAuth() {
    return 'Authorization' in this.authHeader;
  }

  /**
   * Make an HTTP request.
   * All requests use json bodies.
   * All requests expect a 200 statusCode on success
   * @param {object|string} hook - may be a absolute or relative url, or an object
   * @param {string} [hook.url] - an absolute or relative url
   * @param {string} [hook.method] - 'GET' or 'POST'
   * @param {object} [params] - request parameters
   */
  async request(hook, params) {
    params = params || null;
    if (isRelativeUrl(hook)) {
      this.logger.debug({params}, `Requestor:request relative url ${hook}`);
      return await this.post(hook, params, this.authHeader);
    }
    const url = hook.url;
    const method = hook.method || 'POST';
    const authHeader = isRelativeUrl(url) ? this.authHeader : basicAuth(hook.auth);

    assert(url);
    assert(['GET', 'POST'].includes(method));
    return await this[method.toLowerCase()](url, params, authHeader);
  }

}

module.exports = Requestor;
