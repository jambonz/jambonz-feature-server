const assert = require('assert');
const fs = require('fs');
const express = require('express');
const app = express();
const listenPort = process.env.HTTP_PORT || 3000;
let json_mapping = new Map();
let hook_mapping = new Map();

assert.ok(process.env.APP_PATH, 'env var APP_PATH is required');

app.listen(listenPort, () => {
  console.log(`sample jambones app server listening on ${listenPort}`);
});

const applicationData = JSON.parse(fs.readFileSync(process.env.APP_PATH));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/*
 * Markup language
 */

app.all('/', (req, res) => {
  let key = req.body.from
  let retData = json_mapping.has(key) ? JSON.parse(json_mapping.get(key)) : applicationData;
  console.log(retData, `${req.method} /`);
  addRequestToMap(key, req, hook_mapping);
  return res.json(retData);
});

app.post('/appMapping', (req, res) => {
  console.log(req.body, 'POST /appMapping');
  json_mapping.set(req.body.from, req.body.data);
  return res.sendStatus(200);
});

/*
 * Status Callback
 */
app.post('/callStatus', (req, res) => {
  console.log({payload: req.body}, 'POST /callStatus');
  let key = req.body.from + "_callStatus"
  addRequestToMap(key, req, hook_mapping);
  return res.sendStatus(200);
});
/*
 * action Hook
 */
app.post('/actionHook', (req, res) => {
  console.log({payload: req.body}, 'POST /actionHook');
  let key = req.body.from + "_actionHook"
  addRequestToMap(key, req, hook_mapping);
  return res.sendStatus(200);
});

// Fetch Requests
app.get('/requests/:key', (req, res) => {
  let key = req.params.key;
  if (hook_mapping.has(key)) {
    return res.json(hook_mapping.get(key));
  } else {
    return res.sendStatus(404);
  }

})

app.get('/lastRequest/:key', (req, res) => {
  let key = req.params.key;
  if (hook_mapping.has(key)) {
    let requests = hook_mapping.get(key);
    return res.json(requests[requests.length - 1]);
  } else {
    return res.sendStatus(404);
  }
})

/*
 * private function
 */

function addRequestToMap(key, req, map) {
  let headers = new Map()
  for(let i = 0; i < req.rawHeaders.length; i++) {
    if (i % 2 === 0) {
      headers.set(req.rawHeaders[i], req.rawHeaders[i + 1])
    }
  }
  let request = {
    'url': req.url,
    'headers': Object.fromEntries(headers),
    'body': req.body
  }
  if (map.has(key)) {
    map.get(key).push(request);
  } else {
    map.set(key, [request]);
  }
}
