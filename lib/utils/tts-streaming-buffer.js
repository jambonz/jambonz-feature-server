const Emitter = require('events');
const assert = require('assert');
const {
  DeepgramTtsStreamingEvents,
  TtsStreamingEvents,
  TtsStreamingConnectionStatus
} = require('../utils/constants');
const FEED_INTERVAL = 2000;
const MAX_CHUNK_SIZE = 1800;
const HIGH_WATER_BUFFER_SIZE = 5000;
const LOW_WATER_BUFFER_SIZE = 1000;


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
      this._connectionStatus === TtsStreamingConnectionStatus.NotConnected ||
      this._connectionStatus === TtsStreamingConnectionStatus.Failed,
      'TtsStreamingBuffer:start already started');

    if (this.eventHandlers.length === 0) {
      this._initHandlers(this.ep);
    }

    this._connectionStatus = TtsStreamingConnectionStatus.Connecting;
    try {
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
    const starting = this.tokens === '';
    const displayedTokens = tokens.length <= 40 ? tokens : tokens.substring(0, 40);
    const totalLength = tokens.length;

    /* if we crossed the high water mark, reject the request */
    if (this.tokens.length + totalLength > HIGH_WATER_BUFFER_SIZE) {
      this.logger.info(
        `TtsStreamingBuffer:bufferTokensTTS buffer is full, rejecting request to buffer ${totalLength} tokens`);

      if (!this._isFull) {
        this._isFull = true;
        this.emit(TtsStreamingEvents.Pause);
      }
      return {status: 'failed', reason: 'full'};
    }

    this.logger.debug(
      `TtsStreamingBuffer:bufferTokens "${displayedTokens}" (length: ${totalLength}), starting? ${starting}`
    );
    this.tokens += (tokens || '');
    const leftoverTokens = await this._feedTokens();

    /* do we need to start a timer to periodically feed tokens to the endpoint? */
    if (starting && leftoverTokens > 0) {
      assert(!this.timer);
      this.timer = setInterval(async() => {
        const remaining = await this._feedTokens();
        if (remaining === 0) {
          clearInterval(this.timer);
          this.timer = null;
        }
      }, FEED_INTERVAL);
    }

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
      this._api(this.ep, [this.ep.uuid, 'flush'])
        .catch((err) => this.logger.info({err},
          `TtsStreamingBuffer:flush Error flushing TTS streaming: ${JSON.stringify(err)}`));
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
   * Send the next chunk of tokens to the endpoint (max 2000 chars)
   * Return the number of tokens left in the buffer.
   */
  async _feedTokens() {
    this.logger.debug('_feedTokens');
    if (!this.cs.isTtsStreamOpen || !this.ep || !this.tokens) {
      this.logger.debug('TTS stream is not open or no tokens to send');
      return this.tokens?.length || 0;
    }

    if (this._connectionStatus === TtsStreamingConnectionStatus.NotConnected ||
      this._connectionStatus === TtsStreamingConnectionStatus.Failed) {
      await this.start();
      return this.tokens.length;
    }

    if (this._connectionStatus === TtsStreamingConnectionStatus.Connecting) {
      this.logger.debug('TtsStreamingBuffer:_feedTokens TTS stream is not ready, waiting for connect');
      return this.tokens.length;
    }

    // Helper function to find a sentence boundary
    const findSentenceBoundary = (text, limit) => {
      const sentenceEndRegex = /[.!?](?=\s|$)/g;
      let lastSentenceBoundary = -1;
      let match;

      while ((match = sentenceEndRegex.exec(text)) && match.index < limit) {
        // Ensure it's not a decimal point (e.g., "3.14")
        if (match.index === 0 || !/\d$/.test(text[match.index - 1])) {
          lastSentenceBoundary = match.index + 1; // Include the punctuation
        }
      }
      return lastSentenceBoundary;
    };

    // Helper function to find a word boundary
    const findWordBoundary = (text, limit) => {
      const wordBoundaryRegex = /\s+/g;
      let lastWordBoundary = -1;
      let match;

      while ((match = wordBoundaryRegex.exec(text)) && match.index < limit) {
        lastWordBoundary = match.index;
      }
      return lastWordBoundary;
    };

    // Try to find the best chunk to send
    const limit = Math.min(MAX_CHUNK_SIZE, this.tokens.length);
    let chunkEnd = findSentenceBoundary(this.tokens, limit);

    if (chunkEnd === -1) {
      // If no sentence boundary, try word boundary
      chunkEnd = findWordBoundary(this.tokens, limit);
    }

    if (chunkEnd === -1) {
      // If no boundaries at all, just take the max allowed
      chunkEnd = limit;
    }

    const chunk = this.tokens.slice(0, chunkEnd);
    this.tokens = this.tokens.slice(chunkEnd); // Remove sent chunk and trim whitespace

    /* freeswitch looks for sequence of 2 newlines to determine end of message, so insert a space */
    const modifiedChunk = chunk.replace(/\n\n/g, '\n \n');
    if (modifiedChunk.length > 0) {
      try {
        await this._api(this.ep, [this.ep.uuid, 'send', modifiedChunk]);
      } catch (err) {
        this.logger.info({err}, 'TtsStreamingBuffer:_feedTokens Error sending TTS chunk');
      }

      this.logger.debug(`TtsStreamingBuffer:_feedTokens: sent ${chunk.length}, remaining: ${this.tokens.length}`);

      if (this.isFull && this.tokens.length <= LOW_WATER_BUFFER_SIZE) {
        this.logger.info('TtsStreamingBuffer:_feedTokens TTS streaming buffer is no longer full');
        this._isFull = false;
        this.emit(TtsStreamingEvents.Resume);
      }
    }

    if (0 === this.tokens.length && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    return this.tokens.length;
  }

  async _api(ep, args) {
    const res = await ep.api('uuid_deepgram_tts_streaming', `^^|${args.join('|')}`);
    if (!res.body?.startsWith('+OK')) {
      throw new Error({args}, `Error calling uuid_deepgram_tts_streaming: ${res.body}`);
    }
  }

  _onConnectFailure(vendor) {
    this.emit(TtsStreamingEvents.ConnectFailure, {vendor});
  }

  async _onConnect(vendor) {
    this.logger.debug('ws api connected');
    this._connectionStatus = TtsStreamingConnectionStatus.Connected;
    if (this.tokens.length > 0) {
      await this._feedTokens();
    }
    if (this._flushPending) {
      this.flush();
      this._flushPending = false;
    }
  }

  _onTtsEmpty(vendor) {
    this.emit(TtsStreamingEvents.Empty, {vendor});
  }

  _initHandlers(ep) {
    this.addCustomEventListener(ep, DeepgramTtsStreamingEvents.Connect,
      this._onConnect.bind(this, 'deepgram'));
    this.addCustomEventListener(ep, DeepgramTtsStreamingEvents.ConnectFailure,
      this._onConnectFailure.bind(this, 'deepgram'));
    this.addCustomEventListener(ep, DeepgramTtsStreamingEvents.Empty,
      this._onTtsEmpty.bind(this, 'deepgram'));
  }

  addCustomEventListener(ep, event, handler) {
    this.eventHandlers.push({ep, event, handler});
    ep.addCustomEventListener(event, handler);
  }

  removeCustomEventListeners() {
    this.eventHandlers.forEach((h) => h.ep.removeCustomEventListener(h.event, h.handler));
  }

}

module.exports = TtsStreamingBuffer;
