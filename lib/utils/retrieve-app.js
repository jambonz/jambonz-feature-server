const request = require('request');
//require('request-debug')(request);
const makeTask = require('../tasks/make_task');
const normalizeJamones = require('./normalize-jamones');


function retrieveUrl(logger, url, method, auth, obj) {
  const opts = {url, method, auth, json: true};
  if (method === 'GET') Object.assign(opts, {qs: obj});
  else Object.assign(opts, {body: obj});

  return new Promise((resolve, reject) => {
    request(opts, (err, response, body) => {
      if (err) throw err;
      if (response.statusCode === 401) return reject(new Error('HTTP request failed: Unauthorized'));
      else if (response.statusCode !== 200) return reject(new Error(`HTTP request failed: ${response.statusCode}`));
      if (body) logger.debug({body}, 'retrieveUrl: ${method} ${url} returned an application');
      resolve(body);
    });
  });
}

async function retrieveApp(logger, url, method, auth, obj) {
  let json;

  if (typeof url === 'object') json = url;
  else json = await retrieveUrl(logger, url, method, auth, obj);
  return normalizeJamones(logger, json).map((tdata) => makeTask(logger, tdata));
}

module.exports = retrieveApp;
