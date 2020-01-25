const request = require('request');
const retrieveApp = require('./retrieve-app');

function hooks(logger, callAttributes) {
  function actionHook(url, method, auth, opts, expectResponse = true) {
    const params = Object.assign({}, callAttributes, opts);
    let basicauth, qs, body;
    if (auth && typeof auth === 'object' && Object.keys(auth) === 2) basicauth = auth;
    if ('GET' === method.toUpperCase()) qs = params;
    else body = params;
    const obj = {url, method, auth: basicauth, json: expectResponse || !!body, qs, body};
    logger.debug({opts: obj}, 'actionHook');
    return new Promise((resolve, reject) => {
      request(obj, (err, response, body) => {
        if (err) {
          logger.info(`actionHook error ${method} ${url}: ${err.message}`);
          return reject(err);
        }
        if (body && expectResponse) {
          logger.debug(body, `actionHook response ${method} ${url}`);
          return resolve(retrieveApp(logger, body));
        }
        resolve(body);
      });
    });
  }

  function notifyHook(url, method, auth, opts) {
    return actionHook(url, method, auth, opts, false);
  }

  return {
    actionHook,
    notifyHook
  };
}

module.exports = hooks;
