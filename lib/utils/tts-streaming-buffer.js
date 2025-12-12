const Emitter = require('events');
const assert = require('assert');
const {
  TtsStreamingEvents,
  TtsStreamingConnectionStatus
} = require('../utils/constants');
const { JAMBONES_TTS_STREAM_AUTO_FLUSH } = require('../config');

const MAX_CHUNK_SIZE = 1800;
const HIGH_WATER_BUFFER_SIZE = 1000;
const LOW_WATER_BUFFER_SIZE = 200;
const TIMEOUT_RETRY_MSECS = 1000; // 1 second


const isWhitespace = (str) => /^\s*$/.test(str);

/**
 * Each queue item is an object:
 *   - { type: 'text', value: '…' } for text tokens.
 *   - { type: 'flush' } for a flush command.
 */
class TtsStreamingBuffer extends Emitter {
  constructor(cs) {
    super();
    this.cs = cs;
    this.logger = cs.logger;

    // Use an array to hold our structured items.
    this.queue = [];
    // Track total number of characters in text items.
    this.bufferedLength = 0;
    this.eventHandlers = [];
    this._isFull = false;
    this._connectionStatus = TtsStreamingConnectionStatus.NotConnected;
    this.timer = null;
    // Record the last time the text buffer was updated.
    this.lastUpdateTime = 0;
  }

  get isEmpty() {
    return this.queue.length === 0;
  }

  get size() {
    return this.bufferedLength;
  }

  get isFull() {
    return this._isFull;
  }

  get ep() {
    return this.cs?.ep;
  }

  async start() {
    assert.ok(
      this._connectionStatus === TtsStreamingConnectionStatus.NotConnected,
      'TtsStreamingBuffer:start already started, or has failed'
    );

    this.vendor = this.cs.getTsStreamingVendor();
    if (!this.vendor) {
      this.logger.info('TtsStreamingBuffer:start No TTS streaming vendor configured');
      throw new Error('No TTS streaming vendor configured');
    }

    this.logger.info(`TtsStreamingBuffer:start Connecting to TTS streaming with vendor ${this.vendor}`);

    this._connectionStatus = TtsStreamingConnectionStatus.Connecting;
    try {
      if (this.eventHandlers.length === 0) this._initHandlers(this.ep);
      await this._api(this.ep, [this.ep.uuid, 'connect']);
    } catch (err) {
      this.logger.info({ err }, 'TtsStreamingBuffer:start Error connecting to TTS streaming');
      this._connectionStatus = TtsStreamingConnectionStatus.Failed;
    }
  }

  stop() {
    clearTimeout(this.timer);
    this.removeCustomEventListeners();
    if (this.ep) {
      this._api(this.ep, [this.ep.uuid, 'stop'])
        .catch((err) =>
          this.logger.info({ err }, 'TtsStreamingBuffer:stop Error closing TTS streaming')
        );
    }
    this.timer = null;
    this.queue = [];
    this.bufferedLength = 0;
    this._connectionStatus = TtsStreamingConnectionStatus.NotConnected;
  }

  /**
   * Buffer new text tokens.
   */
  async bufferTokens(tokens) {
    if (this._connectionStatus === TtsStreamingConnectionStatus.Failed) {
      this.logger.info('TtsStreamingBuffer:bufferTokens TTS streaming connection failed, rejecting request');
      return { status: 'failed', reason: `connection to ${this.vendor} failed` };
    }

    if (0 === this.bufferedLength && isWhitespace(tokens)) {
      this.logger.debug({tokens}, 'TtsStreamingBuffer:bufferTokens discarded whitespace tokens');
      return { status: 'ok' };
    }

    const displayedTokens = tokens.length <= 40 ? tokens : tokens.substring(0, 40);
    const totalLength = tokens.length;

    if (this.bufferedLength + totalLength > HIGH_WATER_BUFFER_SIZE) {
      this.logger.info(
        `TtsStreamingBuffer throttling: buffer is full, rejecting request to buffer ${totalLength} tokens`
      );
      if (!this._isFull) {
        this._isFull = true;
        this.emit(TtsStreamingEvents.Pause);
      }
      return { status: 'failed', reason: 'full' };
    }

    this.logger.debug(
      `TtsStreamingBuffer:bufferTokens "${displayedTokens}" (length: ${totalLength})`
    );
    this.queue.push({ type: 'text', value: tokens });
    this.bufferedLength += totalLength;
    // Update the last update time each time new text is buffered.
    this.lastUpdateTime = Date.now();

    await this._feedQueue();
    return { status: 'ok' };
  }

  /**
   * Insert a flush command. If no text is queued, flush immediately.
   * Otherwise, append a flush marker so that all text preceding it will be sent
   * (regardless of sentence boundaries) before the flush is issued.
   */
  flush() {
    if (this._connectionStatus === TtsStreamingConnectionStatus.Connecting) {
      this.logger.debug('TtsStreamingBuffer:flush TTS stream is not quite ready - wait for connect');
      if (this.queue.length === 0 || this.queue[this.queue.length - 1].type !== 'flush') {
        this.queue.push({ type: 'flush' });
      }
      return;
    }
    else if (this._connectionStatus === TtsStreamingConnectionStatus.Connected) {
      if (this.isEmpty) {
        this._doFlush();
      }
      else {
        if (this.queue[this.queue.length - 1].type !== 'flush') {
          this.queue.push({ type: 'flush' });
          this.logger.debug('TtsStreamingBuffer:flush added flush marker to queue');
        }
      }
    }
    else {
      this.logger.debug(
        `TtsStreamingBuffer:flush TTS stream is not connected, status: ${this._connectionStatus}`
      );
    }
  }

  clear() {
    if (this._connectionStatus !== TtsStreamingConnectionStatus.Connected) return;
    clearTimeout(this.timer);
    this._api(this.ep, [this.ep.uuid, 'clear']).catch((err) =>
      this.logger.info({ err }, 'TtsStreamingBuffer:clear Error clearing TTS streaming')
    );
    this.queue = [];
    this.bufferedLength = 0;
    this.timer = null;
    this._isFull = false;
  }

  /**
   * Process the queue in two phases.
   *
   * Phase 1: Look for flush markers. When a flush marker is found (even if not at the very front),
   *   send all text tokens that came before it immediately (ignoring sentence boundaries)
   *   and then send the flush command. Repeat until there are no flush markers left.
   *
   * Phase 2: With the remaining queue (now containing only text items), accumulate text
   *   up to MAX_CHUNK_SIZE and use sentence-boundary logic to determine a chunk.
   *   Then, remove the exact tokens (or portions thereof) that were consumed.
   */
  async _feedQueue(handlingTimeout = false) {
    this.logger.debug({ queue: this.queue }, 'TtsStreamingBuffer:_feedQueue');
    try {
      if (!this.cs.isTtsStreamOpen || !this.ep) {
        this.logger.debug('TtsStreamingBuffer:_feedQueue TTS stream is not open or no endpoint available');
        return;
      }
      if (this._connectionStatus !== TtsStreamingConnectionStatus.Connected) {
        this.logger.debug('TtsStreamingBuffer:_feedQueue TTS stream is not connected');
        return;
      }

      // --- Phase 1: Process flush markers ---
      // Process any flush marker that isn’t in the very first position.
      let flushIndex = this.queue.findIndex((item, idx) => item.type === 'flush' && idx > 0);
      while (flushIndex !== -1) {
        let flushText = '';
        // Accumulate all text tokens preceding the flush marker.
        for (let i = 0; i < flushIndex; i++) {
          if (this.queue[i].type === 'text') {
            flushText += this.queue[i].value;
          }
        }
        // Remove those text items.
        for (let i = 0; i < flushIndex; i++) {
          const item = this.queue.shift();
          if (item.type === 'text') {
            this.bufferedLength -= item.value.length;
          }
        }
        // Remove the flush marker (now at the front).
        if (this.queue.length > 0 && this.queue[0].type === 'flush') {
          this.queue.shift();
        }
        // Immediately send all accumulated text (ignoring sentence boundaries).
        if (flushText.length > 0) {
          const modifiedFlushText = flushText.replace(/\n\n/g, '\n \n');
          try {
            await this._api(this.ep, [this.ep.uuid, 'send', modifiedFlushText]);
          } catch (err) {
            this.logger.info({ err, flushText }, 'TtsStreamingBuffer:_feedQueue Error sending TTS chunk');
          }
        }
        // Send the flush command.
        await this._doFlush();

        flushIndex = this.queue.findIndex((item, idx) => item.type === 'flush' && idx > 0);
      }

      // If a flush marker is at the very front, process it.
      while (this.queue.length > 0 && this.queue[0].type === 'flush') {
        this.queue.shift();
        await this._doFlush();
      }

      // --- Phase 2: Process remaining text tokens ---
      if (this.queue.length === 0) {
        this._removeTimer();
        return;
      }

      // Accumulate contiguous text tokens (from the front) up to MAX_CHUNK_SIZE.
      let combinedText = '';
      for (const item of this.queue) {
        if (item.type !== 'text') break;
        combinedText += item.value;
        if (combinedText.length >= MAX_CHUNK_SIZE) break;
      }
      if (combinedText.length === 0) {
        this._removeTimer();
        return;
      }

      const limit = Math.min(MAX_CHUNK_SIZE, combinedText.length);
      let isSentenceBoundaryChunk = false;
      let chunkEnd = findSentenceBoundary(combinedText, limit);
      if (chunkEnd > 0) {
        isSentenceBoundaryChunk = true;
      }
      else {
        if (handlingTimeout) {
          chunkEnd = findWordBoundary(combinedText, limit);
          if (chunkEnd <= 0) {
            this._setTimerIfNeeded();
            return;
          }
        } else {
          this._setTimerIfNeeded();
          return;
        }
      }
      const chunk = combinedText.slice(0, chunkEnd);

      // Check if the chunk is only whitespace before processing the queue
      // If so, wait for more meaningful text
      if (isWhitespace(chunk)) {
        this.logger.debug('TtsStreamingBuffer:_feedQueue chunk is only whitespace, waiting for more text');
        this._setTimerIfNeeded();
        return;
      }

      // Now we iterate over the queue items
      // and deduct their lengths until we've accounted for chunkEnd characters.
      let remaining = chunkEnd;
      let tokensProcessed = 0;
      for (let i = 0; i < this.queue.length; i++) {
        const token = this.queue[i];
        if (token.type !== 'text') break;
        if (remaining >= token.value.length) {
          remaining -= token.value.length;
          tokensProcessed = i + 1;
        } else {
          // Partially consumed token: update its value to remove the consumed part.
          token.value = token.value.slice(remaining);
          tokensProcessed = i;
          remaining = 0;
          break;
        }
      }
      // Remove the fully consumed tokens from the front of the queue.
      this.queue.splice(0, tokensProcessed);
      this.bufferedLength -= chunkEnd;

      const modifiedChunk = chunk.replace(/\n\n/g, '\n \n');

      if (isWhitespace(modifiedChunk)) {
        this.logger.debug('TtsStreamingBuffer:_feedQueue modified chunk is only whitespace, restoring queue');
        this.queue.unshift({ type: 'text', value: chunk });
        this.bufferedLength += chunkEnd;
        this._setTimerIfNeeded();
        return;
      }
      this.logger.debug(`TtsStreamingBuffer:_feedQueue sending chunk to tts: ${modifiedChunk}`);

      try {
        await this._api(this.ep, [this.ep.uuid, 'send', modifiedChunk]);
      } catch (err) {
        this.logger.info({ err, chunk }, 'TtsStreamingBuffer:_feedQueue Error sending TTS chunk');
      }

      // Optionally flush on sentence boundaries if the feature flag is enabled.
      if (JAMBONES_TTS_STREAM_AUTO_FLUSH && isSentenceBoundaryChunk) {
        await this._doFlush();
      }

      if (this._isFull && this.bufferedLength <= LOW_WATER_BUFFER_SIZE) {
        this.logger.info('TtsStreamingBuffer throttling: buffer is no longer full - resuming');
        this._isFull = false;
        this.emit(TtsStreamingEvents.Resume);
      }

      return this._feedQueue();
    } catch (err) {
      this.logger.info({ err }, 'TtsStreamingBuffer:_feedQueue Error sending TTS chunk');
      this.queue = [];
      this.bufferedLength = 0;
    }
  }

  async _api(ep, args) {
    const apiCmd = `uuid_${this.vendor.startsWith('custom:') ? 'custom' : this.vendor}_tts_streaming`;
    const res = await ep.api(apiCmd, `^^|${args.join('|')}`);
    if (!res.body?.startsWith('+OK')) {
      this.logger.info({ args }, `Error calling ${apiCmd}: ${res.body}`);
      throw new Error(`Error calling ${apiCmd}: ${res.body}`);
    }
  }

  _doFlush() {
    return this._api(this.ep, [this.ep.uuid, 'flush'])
      .then(() => this.logger.debug('TtsStreamingBuffer:_doFlush sent flush command'))
      .catch((err) =>
        this.logger.info(
          { err },
          `TtsStreamingBuffer:_doFlush Error flushing TTS streaming: ${JSON.stringify(err)}`
        )
      );
  }

  async _onConnect(vendor) {
    this.logger.info(`TtsStreamingBuffer:_onConnect streaming tts connection made to ${vendor} successful`);
    this._connectionStatus = TtsStreamingConnectionStatus.Connected;
    if (this.queue.length > 0) {
      await this._feedQueue();
    }
    this.emit(TtsStreamingEvents.Connected, { vendor });
  }

  _onConnectFailure(vendor) {
    this.logger.info(`TtsStreamingBuffer:_onConnectFailure streaming tts connection failed to ${vendor}`);
    this._connectionStatus = TtsStreamingConnectionStatus.Failed;
    this.queue = [];
    this.bufferedLength = 0;
    this.emit(TtsStreamingEvents.ConnectFailure, { vendor });
  }

  _setTimerIfNeeded() {
    if (this.bufferedLength > 0 && !this.timer) {
      this.logger.debug({queue: this.queue},
        `TtsStreamingBuffer:_setTimerIfNeeded setting timer because ${this.bufferedLength} buffered`);
      this.timer = setTimeout(this._onTimeout.bind(this), TIMEOUT_RETRY_MSECS);
    }
  }

  _removeTimer() {
    if (this.timer) {
      this.logger.debug('TtsStreamingBuffer:_removeTimer clearing timer');
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  _onTimeout() {
    this.logger.debug('TtsStreamingBuffer:_onTimeout Timeout waiting for sentence boundary');
    this.timer = null;
    // Check if new text has been added since the timer was set.
    const now = Date.now();
    if (now - this.lastUpdateTime < TIMEOUT_RETRY_MSECS) {
      this.logger.debug('TtsStreamingBuffer:_onTimeout New text received recently; postponing flush.');
      this._setTimerIfNeeded();
      return;
    }
    this._feedQueue(true);
  }

  _onTtsEmpty(vendor) {
    this.emit(TtsStreamingEvents.Empty, { vendor });
  }

  addCustomEventListener(ep, event, handler) {
    this.eventHandlers.push({ ep, event, handler });
    ep.addCustomEventListener(event, handler);
  }

  removeCustomEventListeners() {
    this.eventHandlers.forEach((h) => h.ep.removeCustomEventListener(h.event, h.handler));
    this.eventHandlers.length = 0;
  }

  _initHandlers(ep) {
    [
      'deepgram',
      'cartesia',
      'elevenlabs',
      'rimelabs',
      'custom'
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
  // Look for punctuation or double newline that signals sentence end.
  // Includes:
  //   - ASCII: . ! ?
  //   - Arabic: ؟ (question mark), ۔ (full stop)
  //   - Japanese: 。 (full stop), ！, ？ (full-width exclamation/question)
  //
  // For languages that use spaces between sentences, we still require
  // whitespace or end-of-string after the mark. For Japanese (no spaces),
  // we treat the punctuation itself as a boundary regardless of following char.
  const sentenceEndRegex = /[.!?؟۔](?=\s|$)|[。！？]|\n\n/g;
  let lastSentenceBoundary = -1;
  let match;
  while ((match = sentenceEndRegex.exec(text)) && match.index < limit) {
    const precedingText = text.slice(0, match.index).trim();
    if (precedingText.length > 0) {
      if (
        match[0] === '\n\n' ||
        (match.index === 0 || !/\d$/.test(text[match.index - 1]))
      ) {
        lastSentenceBoundary = match.index + (match[0] === '\n\n' ? 2 : 1);
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
