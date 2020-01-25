const request = require('request');
//require('request-debug')(request);
const makeTask = require('../tasks/make_task');
const normalizeJamones = require('./normalize-jamones');


function retrieveUrl(logger, url, method, auth, qs, body) {
  logger.debug(`body: ${body}`);
  const opts = {url, method, auth, qs, json: true};
  if (body) {
    logger.debug('adding body');
    Object.assign(opts, {body});
  }
  return new Promise((resolve, reject) => {
    request(opts, (err, response, body) => {
      if (err) throw err;
      resolve(body);
    });
  });
}

async function retrieveApp(logger, url, method, auth, qs, body) {
  let json;

  if (typeof url === 'object') json = url;
  else json = await retrieveUrl(logger, url, method, auth, qs, body);
  return normalizeJamones(logger, json).map((tdata) => makeTask(logger, tdata));
}

module.exports = retrieveApp;
