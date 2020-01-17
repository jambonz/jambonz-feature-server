const request = require('request');
require('request-debug')(request);
const debug = require('debug')('jambonz:feature-server');

function hooks(logger, callAttributes) {
  debug(`notifiers: callAttributes ${JSON.stringify(callAttributes)}`);
  function actionHook(url, method, opts) {
    debug(`notifiers: opts ${JSON.stringify(opts)}`);
    const params = Object.assign({}, callAttributes, opts);
    const obj = {
      url,
      method,
      json: true,
      qs: 'GET' === method ? params : callAttributes,
      body: 'POST' === method ? opts : null
    };
    logger.debug(`${method} ${url} sending ${JSON.stringify(obj)}`);
    return new Promise((resolve, reject) => {
      request(obj, (err, response, body) => {
        if (err) {
          this.logger.info(`TaskDial:_actionHook error ${method} ${url}: ${err.message}`);
          return reject(err);
        }
        if (body) {
          this.logger.debug(body, `TaskDial:_actionHook response ${method} ${url}`);
        }
        resolve(body);
      });
    });
  }

  return {
    actionHook
  };
}

module.exports = hooks;
