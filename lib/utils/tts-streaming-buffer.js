const Emitter = require('events');
const assert = require('assert');
const FEED_INTERVAL = 2000;
const MAX_CHUNK_SIZE = 2000;

class TtsStreamingBuffer extends Emitter {
  constructor(cs) {
    super();
    this.cs = cs;
    this.logger = cs.logger;

    this.tokens = null;
  }

  get isEmpty() {
    return this.tokens.length === 0;
  }

  get size() {
    return this.tokens.length;
  }

  get ep() {
    return this.cs?.ep;
  }

  /**
   * Add tokens to the buffer and start feeding them to the endpoint if necessary.
   */
  bufferTokens(tokens) {
    const starting = this.tokens === null;
    this.tokens += (tokens || '');
    const leftoverTokens = this.feedTokens();

    /* do we need to start a timer to periodically feed tokens to the endpoint? */
    if (starting && leftoverTokens > 0) {
      assert(!this.timer);
      this.timer = setInterval(() => {
        const remaining = this._feedTokens();
        if (remaining === 0) {
          clearInterval(this.timer);
          this.timer = null;
        }
      }, FEED_INTERVAL);
    }
  }

  flush() {
    clearTimeout(this.timer);
    this._api(this.ep, [this.ep.uuid, 'clear'])
      .catch((err) => this.logger.info({err}, 'Error flushing TTS streaming'));
    this.tokens = null;
    this.timer = null;
  }

  /**
   * Send the next chunk of tokens to the endpoint (max 2000 chars)
   * Return the number of tokens left in the buffer.
   */
  _feedTokens() {
    if (!this.cs.isTtsStreamOpen || !this.ep || !this.tokens) {
      return this.tokens?.length || 0;
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
    this.tokens = this.tokens.slice(chunkEnd).trim(); // Remove sent chunk and trim whitespace

    // Send the chunk to the endpoint
    // TODO: abstract this into an endpoint method
    this._api(this.ep, [this.ep.uuid, 'send', chunk])
      .then(() => this.logger.debug(`Sent chunk: ${chunk}`))
      .catch((err) => {
        this.logger.info({err}, 'Error sending TTS chunk');
      });


    return this.tokens.length;
  }

  async _api(ep, args) {
    const res = await ep.api('uuid_deepgram_tts_streaming', `^^|${args.join('|')}`);
    if (!res.body?.startsWith('+OK')) {
      throw new Error({args}, `Error calling uuid_deepgram_tts_streaming: ${res.body}`);
    }
  }

  kill() {
    clearTimeout(this.timer);
    this._api(this.ep, [this.ep.uuid, 'close'])
      .catch((err) => this.logger.info({err}, 'Error closing TTS streaming'));
    this.timer = null;
    this.tokens = null;
    this.cs = null;
  }

}

module.exports = TtsStreamingBuffer;
