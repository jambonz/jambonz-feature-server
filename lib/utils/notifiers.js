const request = require('request');
//require('request-debug')(request);
const makeTask = require('../tasks/make_task');
const normalizeJamones = require('./normalize-jamones');

const debug = require('debug')('jambonz:feature-server');

function hooks(logger, callAttributes) {
  debug(`notifiers: callAttributes ${JSON.stringify(callAttributes)}`);
  function actionHook(url, method, auth, opts, expectResponse = false) {
    const params = Object.assign({}, callAttributes, opts);
    let basicauth, qs, body;
    if (auth && typeof auth === 'object' && Object.keys(auth) === 2) basicauth = auth;
    if ('GET' === method.toUpperCase()) qs = params;
    else body = params;
    const obj = {url, method, auth: basicauth, json: expectResponse || body, qs, body};
    logger.debug({opts: obj}, 'actionHook');
    return new Promise((resolve, reject) => {
      request(obj, (err, response, body) => {
        if (err) {
          logger.info(`actionHook error ${method} ${url}: ${err.message}`);
          return reject(err);
        }
        if (body) {
          logger.debug(body, `actionHook response ${method} ${url}`);
          if (expectResponse) {
            const tasks = normalizeJamones(logger, body).map((tdata) => makeTask(logger, tdata));
            return resolve(tasks);
          }
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
