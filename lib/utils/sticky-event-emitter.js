const EventEmitter = require('events');

/**
 * A specialized EventEmitter that caches the most recent event emissions.
 * When new listeners are added, they immediately receive the most recent
 * event if it was previously emitted. This is useful for handling state
 * changes where late subscribers need to know the current state.
 *
 * Features:
 * - Caches the most recent emission for each event type
 * - New listeners immediately receive the cached event if available
 * - Supports both regular (on) and one-time (once) listeners
 * - Maintains compatibility with Node's EventEmitter interface
 */
class StickyEventEmitter extends EventEmitter {
  constructor() {
    super();
    this._eventCache = new Map();
    this._onceListeners = new Map(); // For storing once listeners if needed
  }
  destroy() {
    this._eventCache.clear();
    this._onceListeners.clear();
    this.removeAllListeners();
  }
  emit(event, ...args) {
    // Store the event and its args
    this._eventCache.set(event, args);

    // If there are any 'once' listeners waiting, call them
    if (this._onceListeners.has(event)) {
      const listeners = this._onceListeners.get(event);
      for (const listener of listeners) {
        listener(...args);
      }
      if (this.onSuccess) {
        this.onSuccess();
      }
      this._onceListeners.delete(event);
      // return from here as the event listener is already called
      // this is to avoid calling the native emit method which
      // will call the event listener again
      return true;
    }

    return super.emit(event, ...args);
  }

  on(event, listener) {
    if (this._eventCache.has(event)) {
      listener(...this._eventCache.get(event));
    }
    return super.on(event, listener);
  }

  once(event, listener) {
    if (this._eventCache.has(event)) {
      listener(...this._eventCache.get(event));
      if (this.onSuccess) {
        this.onSuccess();
      }
    } else {
      // Store listener in case emit comes before
      if (!this._onceListeners.has(event)) {
        this._onceListeners.set(event, []);
      }
      this._onceListeners.get(event).push(listener);
      super.once(event, listener); // Also attach to native once
    }
    return this;
  }
}

module.exports = StickyEventEmitter;
