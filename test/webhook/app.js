const express = require('express');
const app = express();
const Websocket = require('ws');
const listenPort = process.env.HTTP_PORT || 3000;
let json_mapping = new Map();
let hook_mapping = new Map();
let ws_packet_count = new Map();
let ws_metadata = new Map();

/** websocket server for listen audio  */
const recvAudio = (socket, req) => {
  let packets = 0;
  let path = req.url;
  console.log('received websocket connection');
  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      try {
        const msg = JSON.parse(data);
        console.log({msg}, 'received websocket message');
        ws_metadata.set(path, msg);
      }
      catch (err) {
        console.log({err}, 'error parsing websocket message');
      }
    }
    else {
      packets += data.length;
    }
  });
  socket.on('error', (err) => {
    console.log({err}, 'listen websocket: error');
  });

  socket.on('close', () => {
    ws_packet_count.set(path, packets);
  })
};

const wsServer = new Websocket.Server({ noServer: true });
wsServer.setMaxListeners(0);
wsServer.on('connection', recvAudio.bind(null));

const server = app.listen(listenPort, () => {
  console.log(`sample jambones app server listening on ${listenPort}`);
});
server.on('upgrade', (request, socket, head) => {
  console.log('received upgrade request');
  wsServer.handleUpgrade(request, socket, head, (socket) => {
    wsServer.emit('connection', socket, request);
  });
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/*
 * Markup language
 */

app.all('/', (req, res) => {
  console.log(req.body, 'POST /');
  const key = req.body.from
  addRequestToMap(key, req, hook_mapping);
  return getJsonFromMap(key, req, res);
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
 * transcriptionHook
 */
app.post('/transcriptionHook', (req, res) => {
  console.log({payload: req.body}, 'POST /transcriptionHook');
  let key = req.body.from + "_actionHook"
  addRequestToMap(key, req, hook_mapping);
  return res.json([{"verb": "hangup"}]);
});
/*
 * actionHook
 */
app.post('/actionHook', (req, res) => {
  console.log({payload: req.body}, 'POST /actionHook');
  let key = req.body.from + "_actionHook"
  addRequestToMap(key, req, hook_mapping);
  return res.sendStatus(200);
});

/*
* customHook
* For the hook to return
 */

app.all('/customHook', (req, res) => {
  let key = `${req.body.from}_customHook`;;
  console.log(req.body, `POST /customHook`);
  return getJsonFromMap(key, req, res);
});

app.post('/customHookMapping', (req, res) => {
  let key = `${req.body.from}_customHook`;
  console.log(req.body, `POST /customHookMapping`);
  json_mapping.set(key, req.body.data);
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

// WS Fetch
app.get('/ws_packet_count/:key', (req, res) => {
  let key = `/${req.params.key}`;
  console.log(key, ws_packet_count);
  if (ws_packet_count.has(key)) {
    return res.json({ count: ws_packet_count.get(key) });
  } else {
    return res.sendStatus(404);
  }
})

app.get('/ws_metadata/:key', (req, res) => {
  let key = `/${req.params.key}`;
  console.log(key, ws_packet_count);
  if (ws_metadata.has(key)) {
    return res.json({ metadata: ws_metadata.get(key) });
  } else {
    return res.sendStatus(404);
  }
})

/*
 * private function
 */

function getJsonFromMap(key, req, res) {
  if (!json_mapping.has(key)) return res.sendStatus(404);
  const retData = JSON.parse(json_mapping.get(key));
  console.log(retData, ` Response to ${req.method} ${req.url}`);
  addRequestToMap(key, req, hook_mapping);
  return res.json(retData);
}

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
