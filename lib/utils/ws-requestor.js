const assert = require('assert');
const BaseRequestor = require('./base-requestor');
const short = require('short-uuid');
const {HookMsgTypes} = require('./constants.json');
const Websocket = require('ws');
const snakeCaseKeys = require('./snakecase-keys');
const HttpRequestor = require('./http-requestor');
const MAX_RECONNECTS = 5;
const RESPONSE_TIMEOUT_MS = process.env.JAMBONES_WS_API_MSG_RESPONSE_TIMEOUT || 5000;

class WsRequestor extends BaseRequestor {
  constructor(logger, account_sid, hook, secret) {
    super(logger, account_sid, hook, secret);
    this.connections = 0;
    this.messagesInFlight = new Map();
    this.maliciousClient = false;
    this.closedGracefully = false;
    this.backoffMs = 500;
    this.connectInProgress = false;
    this.queuedMsg = [];
    this.id = short.generate();

    assert(this._isAbsoluteUrl(this.url));

    this.on('socket-closed', this._onSocketClosed.bind(this));
  }

  /**
   * Send a JSON payload over the websocket.  If this is the first request,
   * open the websocket.
   * All requests expect an ack message in response
   * @param {object|string} hook - may be a absolute or relative url, or an object
   * @param {string} [hook.url] - an absolute or relative url
   * @param {string} [hook.method] - 'GET' or 'POST'
   * @param {string} [hook.username] - if basic auth is protecting the endpoint
   * @param {string} [hook.password] - if basic auth is protecting the endpoint
   * @param {object} [params] - request parameters
   */
  async request(type, hook, params, httpHeaders = {}) {
    assert(HookMsgTypes.includes(type));
    const url = hook.url || hook;

    if (this.maliciousClient) {
      this.logger.info({url: this.url}, 'WsRequestor:request - discarding msg to malicious client');
      return;
    }
    if (this.closedGracefully) {
      this.logger.debug(`WsRequestor:request - discarding ${type} because we closed the socket`);
      return;
    }

    if (type === 'session:new') this.call_sid = params.callSid;

    /* if we have an absolute url, and it is http then do a standard webhook */
    if (this._isAbsoluteUrl(url) && url.startsWith('http')) {
      this.logger.debug({hook}, 'WsRequestor: sending a webhook (HTTP)');
      const h = typeof hook === 'object' ? hook : {url: hook};
      const requestor = new HttpRequestor(this.logger, this.account_sid, h, this.secret);
      if (type === 'session:redirect') {
        this.close();
        this.emit('handover', requestor);
      }
      return requestor.request(type, hook, params, httpHeaders);
    }

    /* connect if necessary */
    if (!this.ws) {
      if (this.connectInProgress) {
        this.logger.debug(
          `WsRequestor:request(${this.id}) - queueing ${type} message since we are connecting`);
        this.queuedMsg.push({type, hook, params, httpHeaders});
        return;
      }
      this.connectInProgress = true;
      this.logger.debug(`WsRequestor:request(${this.id}) - connecting since we do not have a connection`);
      if (this.connections >= MAX_RECONNECTS) {
        return Promise.reject(`max attempts connecting to ${this.url}`);
      }
      try {
        const startAt = process.hrtime();
        await this._connect();
        const rtt = this._roundTrip(startAt);
        this.stats.histogram('app.hook.connect_time', rtt, ['hook_type:app']);
      } catch (err) {
        this.logger.info({url, err}, 'WsRequestor:request - failed connecting');
        this.connectInProgress = false;
        return Promise.reject(err);
      }
    }
    assert(this.ws);

    /* prepare and send message */
    let payload = params ? snakeCaseKeys(params, ['customerData', 'sip']) : null;
    if (type === 'session:new') this._sessionData = payload;
    if (type === 'session:reconnect') payload = this._sessionData;
    assert.ok(url, 'WsRequestor:request url was not provided');

    const msgid = short.generate();
    const b3 = httpHeaders?.b3 ? {b3: httpHeaders.b3} : {};
    const obj = {
      type,
      msgid,
      call_sid: this.call_sid,
      hook: type === 'verb:hook' ? url : undefined,
      data: {...payload},
      ...b3
    };

    const sendQueuedMsgs = () => {
      if (this.queuedMsg.length > 0) {
        for (const {type, hook, params, httpHeaders} of this.queuedMsg) {
          this.logger.debug(`WsRequestor:request - preparing queued ${type} for sending`);
          setImmediate(this.request.bind(this, type, hook, params, httpHeaders));
        }
        this.queuedMsg.length = 0;
      }
    };

    //this.logger.debug({obj}, `websocket: sending (${url})`);

    /* simple notifications */
    if (['call:status', 'jambonz:error', 'session:reconnect'].includes(type)) {
      this.ws.send(JSON.stringify(obj), () => {
        this.logger.debug({obj}, `WsRequestor:request websocket: sent (${url})`);
        sendQueuedMsgs();
      });
      return;
    }

    /* messages that require an ack */
    return new Promise((resolve, reject) => {
      /* give the far end a reasonable amount of time to ack our message */
      const timer = setTimeout(() => {
        const {failure} = this.messagesInFlight.get(msgid);
        failure && failure(`timeout from far end for msgid ${msgid}`);
        this.messagesInFlight.delete(msgid);
      }, RESPONSE_TIMEOUT_MS);

      /* save the message info for reply */
      const startAt = process.hrtime();
      this.messagesInFlight.set(msgid, {
        timer,
        success: (response) => {
          clearTimeout(timer);
          const rtt = this._roundTrip(startAt);
          this.logger.debug({response}, `WsRequestor:request ${url} succeeded in ${rtt}ms`);
          this.stats.histogram('app.hook.ws_response_time', rtt, ['hook_type:app']);
          resolve(response);
        },
        failure: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });

      /* send the message */
      this.ws.send(JSON.stringify(obj), () => {
        this.logger.debug({obj}, `WsRequestor:request websocket: sent (${url})`);
        sendQueuedMsgs();
      });
    });
  }

  close() {
    this.closedGracefully = true;
    this.logger.debug('WsRequestor:close closing socket');
    try {
      if (this.ws) {
        this.ws.close();
        this.ws.removeAllListeners();
      }

      for (const [msgid, obj] of this.messagesInFlight) {
        const {timer} = obj;
        clearTimeout(timer);
        obj.failure(`abandoning msgid ${msgid} since we have closed the socket`);
      }
      this.messagesInFlight.clear();

    } catch (err) {
      this.logger.info({err}, 'WsRequestor: Error closing socket');
    }
  }

  _connect() {
    assert(!this.ws);
    return new Promise((resolve, reject) => {
      const handshakeTimeout = process.env.JAMBONES_WS_HANDSHAKE_TIMEOUT_MS ?
        parseInt(process.env.JAMBONES_WS_HANDSHAKE_TIMEOUT_MS) :
        1500;
      let opts = {
        followRedirects: true,
        maxRedirects: 2,
        handshakeTimeout,
        maxPayload: process.env.JAMBONES_WS_MAX_PAYLOAD ? parseInt(process.env.JAMBONES_WS_MAX_PAYLOAD) : 24 * 1024,
      };
      if (this.username && this.password) opts = {...opts, auth: `${this.username}:${this.password}`};

      this
        .once('ready', (ws) => {
          this.removeAllListeners('not-ready');
          if (this.connections > 1) this.request('session:reconnect', this.url);
          resolve();
        })
        .once('not-ready', (err) => {
          this.removeAllListeners('ready');
          reject(err);
        });
      const ws = new Websocket(this.url, ['ws.jambonz.org'], opts);
      this._setHandlers(ws);
    });
  }

  _setHandlers(ws) {
    this.logger.debug('WsRequestor:_setHandlers');
    ws
      .once('open', this._onOpen.bind(this, ws))
      .once('close', this._onClose.bind(this))
      .on('message', this._onMessage.bind(this))
      .once('unexpected-response', this._onUnexpectedResponse.bind(this, ws))
      .on('error', this._onError.bind(this));
  }

  _onError(err) {
    if (this.connections > 0) {
      this.logger.info({url: this.url, err}, 'WsRequestor:_onError');
    }
    else this.emit('not-ready', err);
  }

  _onOpen(ws) {
    this.logger.info({url: this.url}, `WsRequestor(${this.id}) - successfully connected`);
    if (this.ws) this.logger.info({old_ws: this.ws._socket.address()}, 'WsRequestor:_onOpen');
    assert(!this.ws);
    this.ws = ws;
    this.connectInProgress = false;
    this.connections++;
    this.emit('ready', ws);
  }

  _onClose(code) {
    this.logger.info(`WsRequestor(${this.id}) - closed from far end ${code}`);
    if (this.connections > 0 && code !== 1000) {
      this.logger.info({url: this.url}, 'WsRequestor - socket closed unexpectedly from remote side');
      this.emit('socket-closed');
    }
    else if (code === 1000) this.closedGracefully = true;
    this.ws?.removeAllListeners();
    this.ws = null;
  }

  _onUnexpectedResponse(ws, req, res) {
    assert(!this.ws);
    this.logger.info({
      headers: res.headers,
      statusCode: res.statusCode,
      statusMessage: res.statusMessage
    }, 'WsRequestor - unexpected response');
    this.emit('connection-failure');
    this.emit('not-ready', new Error(`${res.statusCode} ${res.statusMessage}`));
  }

  _onSocketClosed() {
    this.ws = null;
    this.emit('connection-dropped');
    if (this.connections > 0 && this.connections < MAX_RECONNECTS && !this.closedGracefully) {
      this.logger.debug(`WsRequestor:_onSocketClosed waiting ${this.backoffMs} to reconnect`);
      setTimeout(() => {
        this.logger.debug(
          {haveWs: !!this.ws, connectInProgress: this.connectInProgress},
          'WsRequestor:_onSocketClosed time to reconnect');
        if (!this.ws && !this.connectInProgress) {
          this.connectInProgress = true;
          this._connect().catch((err) => this.connectInProgress = false);
        }
      }, this.backoffMs);
      this.backoffMs = this.backoffMs < 2000 ? this.backoffMs * 2 : (this.backoffMs + 2000);
    }
  }

  _onMessage(content, isBinary) {
    if (this.isBinary) {
      this.logger.info({url: this.url}, 'WsRequestor:_onMessage - discarding binary message');
      this.maliciousClient = true;
      this.ws.close();
      return;
    }

    /* messages must be JSON format */
    try {
      const obj = JSON.parse(content);
      const {type, msgid, command, call_sid = this.call_sid, queueCommand = false, data} = obj;

      //this.logger.debug({obj}, 'WsRequestor:request websocket: received');
      assert.ok(type, 'type property not supplied');

      switch (type) {
        case 'ack':
          assert.ok(msgid, 'msgid not supplied');
          this._recvAck(msgid, data);
          break;

        case 'command':
          assert.ok(command, 'command property not supplied');
          assert.ok(data, 'data property not supplied');
          this._recvCommand(msgid, command, call_sid, queueCommand, data);
          break;

        default:
          assert.ok(false, `invalid type property: ${type}`);
      }
    } catch (err) {
      this.logger.info({err, content}, 'WsRequestor:_onMessage - invalid incoming message');
    }
  }

  _recvAck(msgid, data) {
    const obj = this.messagesInFlight.get(msgid);
    if (!obj) {
      this.logger.info({url: this.url}, `WsRequestor:_recvAck - ack to unknown msgid ${msgid}, discarding`);
      return;
    }
    this.logger.debug({url: this.url}, `WsRequestor:_recvAck - received response to ${msgid}`);
    this.messagesInFlight.delete(msgid);
    const {success} = obj;
    success && success(data);
  }

  _recvCommand(msgid, command, call_sid, queueCommand, data) {
    // TODO: validate command
    this.logger.debug({msgid, command, call_sid, queueCommand, data}, 'received command');
    this.emit('command', {msgid, command, call_sid, queueCommand, data});
  }
}

module.exports = WsRequestor;
