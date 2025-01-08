const Emitter = require('events');
const assert = require('assert');
const {
  TtsStreamingEvents,
  TtsStreamingConnectionStatus
} = require('../utils/constants');
const MAX_CHUNK_SIZE = 1800;
const HIGH_WATER_BUFFER_SIZE = 1000;
const LOW_WATER_BUFFER_SIZE = 200;
const TIMEOUT_RETRY_MSECS = 3000;

class TtsStreamingBuffer extends Emitter {
  constructor(cs) {
    super();
    this.cs = cs;
    this.logger = cs.logger;

    this.tokens = '';
    this.eventHandlers = [];
    this._isFull = false;
    this._connectionStatus = TtsStreamingConnectionStatus.NotConnected;
    this._flushPending = false;
    this.timer = null;
  }

  get isEmpty() {
    return this.tokens.length === 0;
  }

  get isFull() {
    return this._isFull;
  }

  get size() {
    return this.tokens.length;
  }

  get ep() {
    return this.cs?.ep;
  }

  async start() {
    assert.ok(
      this._connectionStatus === TtsStreamingConnectionStatus.NotConnected,
      'TtsStreamingBuffer:start already started, or has failed');

    this.vendor = this.cs.getTsStreamingVendor();
    if (!this.vendor) {
      this.logger.info('TtsStreamingBuffer:start No TTS streaming vendor configured');
      throw new Error('No TTS streaming vendor configured');
    }

    this.logger.info(`TtsStreamingBuffer:start Connecting to TTS streaming with vendor ${this.vendor}`);

    this._connectionStatus = TtsStreamingConnectionStatus.Connecting;
    try {
      if (this.eventHandlers.length === 0) this._initHandlers(this.ep);
      await  this._api(this.ep, [this.ep.uuid, 'connect']);
    } catch (err) {
      this.logger.info({err}, 'TtsStreamingBuffer:start Error connecting to TTS streaming');
      this._connectionStatus = TtsStreamingConnectionStatus.Failed;
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.removeCustomEventListeners();
    if (this.ep) {
      this._api(this.ep, [this.ep.uuid, 'close'])
        .catch((err) => this.logger.info({err}, 'TtsStreamingBuffer:kill Error closing TTS streaming'));
    }
    this.timer = null;
    this.tokens = '';
    this._connectionStatus = TtsStreamingConnectionStatus.NotConnected;
  }

  /**
   * Add tokens to the buffer and start feeding them to the endpoint if necessary.
   */
  async bufferTokens(tokens) {

    if (this._connectionStatus === TtsStreamingConnectionStatus.Failed) {
      this.logger.info('TtsStreamingBuffer:bufferTokens TTS streaming connection failed, rejecting request');
      return {status: 'failed', reason: `connection to ${this.vendor} failed`};
    }

    const displayedTokens = tokens.length <= 40 ? tokens : tokens.substring(0, 40);
    const totalLength = tokens.length;

    /* if we crossed the high water mark, reject the request */
    if (this.tokens.length + totalLength > HIGH_WATER_BUFFER_SIZE) {
      this.logger.info(
        `TtsStreamingBuffer throttling: buffer is full, rejecting request to buffer ${totalLength} tokens`);

      if (!this._isFull) {
        this._isFull = true;
        this.emit(TtsStreamingEvents.Pause);
      }
      return {status: 'failed', reason: 'full'};
    }

    this.logger.debug(
      `TtsStreamingBuffer:bufferTokens "${displayedTokens}" (length: ${totalLength}), starting? ${this.isEmpty}`
    );
    this.tokens += (tokens || '');

    await this._feedTokens();

    return {status: 'ok'};
  }

  flush() {
    this.logger.debug('TtsStreamingBuffer:flush');
    if (this._connectionStatus === TtsStreamingConnectionStatus.Connecting) {
      this.logger.debug('TtsStreamingBuffer:flush TTS stream is not quite ready - wait for connect');
      this._flushPending = true;
      return;
    }
    else if (this._connectionStatus === TtsStreamingConnectionStatus.Connected) {

      if (this.size === 0) {
        this._doFlush();
      }
      else {
        /* we have tokens queued, so flush after they have been sent */
        this._pendingFlush = true;
      }
    }
  }

  clear() {
    this.logger.debug('TtsStreamingBuffer:clear');

    if (this._connectionStatus !== TtsStreamingConnectionStatus.Connected) return;
    clearTimeout(this.timer);
    this._api(this.ep, [this.ep.uuid, 'clear'])
      .catch((err) => this.logger.info({err}, 'TtsStreamingBuffer:clear Error clearing TTS streaming'));
    this.tokens = '';
    this.timer = null;
    this._isFull = false;
  }

  /**
   * Send tokens to the TTS engine in sentence chunks for best playout
   */
  async _feedTokens(handlingTimeout = false) {
    this.logger.debug({tokens: this.tokens}, '_feedTokens');

    try {

      /* are we in a state where we can feed tokens to the TTS? */
      if (!this.cs.isTtsStreamOpen || !this.ep || !this.tokens) {
        this.logger.debug('TTS stream is not open or no tokens to send');
        return this.tokens?.length || 0;
      }

      if (this._connectionStatus === TtsStreamingConnectionStatus.NotConnected ||
        this._connectionStatus === TtsStreamingConnectionStatus.Failed) {
        this.logger.debug('TtsStreamingBuffer:_feedTokens TTS stream is not connected');
        return;
      }

      if (this._connectionStatus === TtsStreamingConnectionStatus.Connecting) {
        this.logger.debug('TtsStreamingBuffer:_feedTokens TTS stream is not ready, waiting for connect');
        return;
      }

      /* must send at least one sentence */
      const limit = Math.min(MAX_CHUNK_SIZE, this.tokens.length);
      let chunkEnd = findSentenceBoundary(this.tokens, limit);

      if (chunkEnd <= 0) {
        if (handlingTimeout) {
          /* on a timeout we've left some tokens sitting around, so be more aggressive now in sending them */
          chunkEnd = findWordBoundary(this.tokens, limit);
          if (chunkEnd <= 0) {
            this.logger.debug('TtsStreamingBuffer:_feedTokens: no word boundary found');
            this._setTimerIfNeeded();
            return;
          }
        }
        else {
          /* if we just received tokens, we wont send unless we have at least a full sentence */
          this.logger.debug('TtsStreamingBuffer:_feedTokens: no sentence boundary found');
          this._setTimerIfNeeded();
          return;
        }
      }

      const chunk = this.tokens.slice(0, chunkEnd);
      this.tokens = this.tokens.slice(chunkEnd);

      /* freeswitch looks for sequence of 2 newlines to determine end of message, so insert a space */
      const modifiedChunk = chunk.replace(/\n\n/g, '\n \n');
      await this._api(this.ep, [this.ep.uuid, 'send', modifiedChunk]);
      this.logger.debug(`TtsStreamingBuffer:_feedTokens: sent ${chunk.length}, remaining: ${this.tokens.length}`);

      if (this._pendingFlush) {
        this._doFlush();
        this._pendingFlush = false;
      }

      if (this.isFull && this.tokens.length <= LOW_WATER_BUFFER_SIZE) {
        this.logger.info('TtsStreamingBuffer throttling: TTS streaming buffer is no longer full - resuming');
        this._isFull = false;
        this.emit(TtsStreamingEvents.Resume);
      }
    } catch (err) {
      this.logger.info({err}, 'TtsStreamingBuffer:_feedTokens Error sending TTS chunk');
      this.tokens = '';
    }

    return;
  }

  async _api(ep, args) {
    const apiCmd = `uuid_${this.vendor.startsWith('custom:') ? 'custom' : this.vendor}_tts_streaming`;
    const res = await ep.api(apiCmd, `^^|${args.join('|')}`);
    if (!res.body?.startsWith('+OK')) {
      this.logger.info({args}, `Error calling ${apiCmd}: ${res.body}`);
      throw new Error(`Error calling ${apiCmd}: ${res.body}`);
    }
  }

  _onConnectFailure(vendor) {
    this.logger.info(`streaming tts connection failed to ${vendor}`);
    this._connectionStatus = TtsStreamingConnectionStatus.Failed;
    this.tokens = '';
    this.emit(TtsStreamingEvents.ConnectFailure, {vendor});
  }

  _doFlush() {
    this._api(this.ep, [this.ep.uuid, 'flush'])
      .catch((err) => this.logger.info({err},
        `TtsStreamingBuffer:_doFlush Error flushing TTS streaming: ${JSON.stringify(err)}`));
  }

  async _onConnect(vendor) {
    this.logger.info(`streaming tts connection made to ${vendor}`);
    this._connectionStatus = TtsStreamingConnectionStatus.Connected;
    if (this.tokens.length > 0) {
      await this._feedTokens();
    }
    if (this._flushPending) {
      this.flush();
      this._flushPending = false;
    }
  }

  _setTimerIfNeeded() {
    if (this.tokens.length > 0 && !this.timer) {
      this.timer = setTimeout(this._onTimeout.bind(this), TIMEOUT_RETRY_MSECS);
    }
  }

  _onTimeout() {
    this.logger.info('TtsStreamingBuffer:_onTimeout');
    this.timer = null;
    this._feedTokens(true);
  }

  _onTtsEmpty(vendor) {
    this.emit(TtsStreamingEvents.Empty, {vendor});
  }

  addCustomEventListener(ep, event, handler) {
    this.eventHandlers.push({ep, event, handler});
    ep.addCustomEventListener(event, handler);
  }

  removeCustomEventListeners() {
    this.eventHandlers.forEach((h) => h.ep.removeCustomEventListener(h.event, h.handler));
  }

  _initHandlers(ep) {
    [
      // DH: add other vendors here as modules are added
      'deepgram',
      'cartesia',
      'elevenlabs'
    ].forEach((vendor) => {
      const eventClassName = `${vendor.charAt(0).toUpperCase() + vendor.slice(1)}TtsStreamingEvents`;
      const eventClass = require('../utils/constants')[eventClassName];
      if (!eventClass) throw new Error(`Event class for vendor ${vendor} not found`);

      this.addCustomEventListener(ep, eventClass.Connect, this._onConnect.bind(this, vendor));
      this.addCustomEventListener(ep, eventClass.ConnectFailure, this._onConnectFailure.bind(this, vendor));
      this.addCustomEventListener(ep, eventClass.Empty, this._onTtsEmpty.bind(this, vendor));
    });
  }
}

const findSentenceBoundary = (text, limit) => {
  // Match traditional sentence boundaries or double newlines
  const sentenceEndRegex = /[.!?](?=\s|$)|\n\n/g;
  let lastSentenceBoundary = -1;
  let match;

  while ((match = sentenceEndRegex.exec(text)) && match.index < limit) {
    const precedingText = text.slice(0, match.index).trim(); // Extract text before the match and trim whitespace
    if (precedingText.length > 0) { // Check if there's actual content
      if (
        match[0] === '\n\n' || // It's a double newline
        (match.index === 0 || !/\d$/.test(text[match.index - 1])) // Standard punctuation rules
      ) {
        lastSentenceBoundary = match.index + (match[0] === '\n\n' ? 2 : 1); // Include the boundary
      }
    }
  }

  return lastSentenceBoundary;
};

const findWordBoundary = (text, limit) => {
  const wordBoundaryRegex = /\s+/g;
  let lastWordBoundary = -1;
  let match;

  while ((match = wordBoundaryRegex.exec(text)) && match.index < limit) {
    lastWordBoundary = match.index;
  }
  return lastWordBoundary;
};

module.exports = TtsStreamingBuffer;
