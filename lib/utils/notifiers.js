const request = require('request');
//require('request-debug')(request);
const retrieveApp = require('./retrieve-app');

function hooks(logger, callInfo) {
  function actionHook(hook, obj = {}, expectResponse = true) {
    const method = (hook.method || 'POST').toUpperCase();
    const auth = (hook.username && hook.password) ?
      {username: hook.username, password: hook.password} :
      null;

    const data = Object.assign({}, obj, callInfo.toJSON());
    logger.debug({hook, data, auth}, 'actionhook');

    /* customer data only on POSTs */
    if ('GET' === method) delete data.customerData;

    const opts = {
      url: hook.url,
      method,
      json: 'POST' === method || expectResponse
    };
    if (auth) opts.auth = auth;
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

  function notifyHook(hook, opts = {}) {
    return actionHook(hook, opts, false);
  }

  return {
    actionHook,
    notifyHook
  };
}

module.exports = hooks;
