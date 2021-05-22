const assert = require('assert');
const fs = require('fs');
const express = require('express');
const app = express();
const listenPort = process.env.HTTP_PORT || 3000;
let lastAction, lastEvent;

assert.ok(process.env.APP_PATH, 'env var APP_PATH is required');

app.listen(listenPort, () => {
  console.log(`sample jambones app server listening on ${listenPort}`);
});

const applicationData = JSON.parse(fs.readFileSync(process.env.APP_PATH));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());


app.all('/', (req, res) => {
  console.log(applicationData, `${req.method} /`);
  return res.json(applicationData);
});

app.post('/callStatus', (req, res) => {
  console.log({payload: req.body}, 'POST /callStatus');
  return res.sendStatus(200);
});

app.post('/actionHook', (req, res) => {
  console.log({payload: req.body}, 'POST /actionHook');
  lastAction = req.body;
  return res.sendStatus(200);
});

app.get('/actionHook', (req, res) => {
  console.log({payload: lastAction}, 'GET /actionHook');
  return res.json(lastAction);
});

app.post('/eventHook', (req, res) => {
  console.log({payload: req.body}, 'POST /eventHook');
  lastEvent = req.body;
  return res.sendStatus(200);
});

app.get('/eventHook', (req, res) => {
  console.log({payload: lastEvent}, 'GET /eventHook');
  return res.json(lastEvent);
});
