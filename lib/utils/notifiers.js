const request = require('request');
require('request-debug')(request);
const retrieveApp = require('./retrieve-app');

function hooks(logger, callInfo) {
  logger.debug({callInfo}, 'creating action hook');
  function actionHook(hook, obj = {}, expectResponse = true) {
    const method = hook.method.toUpperCase();
    const auth = (hook.username && hook.password) ?
      {username: hook.username, password: hook.password} :
      null;

    const data = Object.assign({}, obj, callInfo);
    logger.debug({data}, `actionhook sending to ${hook.url}`);
    if ('GET' === method) {
      // remove customer data - only for POSTs since it might be quite complex
      delete data.customerData;
    }
    const opts = {
      url: hook.url,
      method,
      json: 'POST' === method || expectResponse
    };
    if (auth) obj.auth = auth;
    if ('POST' === method) opts.body = data;
    else opts.qs = data;

    return new Promise((resolve, reject) => {
      request(opts, (err, response, body) => {
        if (err) {
          logger.info(`actionHook error ${method} ${hook.url}: ${err.message}`);
          return reject(err);
        }
        if (body && expectResponse) {
          logger.debug(body, `actionHook response ${method} ${hook.url}`);
          return resolve(retrieveApp(logger, body));
        }
        resolve(body);
      });
    });
  }

  function notifyHook(url, method, auth, opts = {}) {
    return actionHook(url, method, auth, opts, false);
  }

  return {
    actionHook,
    notifyHook
  };
}

module.exports = hooks;
