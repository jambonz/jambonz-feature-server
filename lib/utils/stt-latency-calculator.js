const { assert } = require('console');
const Emitter = require('events');
const {
  VadDetection,
} = require('../utils/constants.json');

class SttLatencyCalculator extends Emitter {
  constructor({ logger, cs}) {
    super();
    this.logger = logger;
    this.cs = cs;
    this.isRunning = false;
    this.start_talking_time = 0;
    this.talkspurts = [];
  }

  _onVadDetected(_ep, _evt, fsEvent) {
    if (fsEvent.getHeader('detected-event') === 'stop_talking') {
      this.talkspurts.push({
        start: this.start_talking_time,
        stop: Date.now()
      });

      this.start_talking_time = 0;

    } else if (fsEvent.getHeader('detected-event') === 'start_talking') {
      this.start_talking_time = Date.now();
    }
  }

  _startVad() {
    assert(!this.isRunning, 'Latency calculator is already running');
    assert(this.cs.ep, 'Callsession has no endpoint to start the latency calculator');
    const ep = this.cs.ep;
    if (!ep.sttLatencyVadHandler) {
      ep.sttLatencyVadHandler = this._onVadDetected.bind(this, ep);
      ep.addCustomEventListener(VadDetection.Detection, ep.sttLatencyVadHandler);
    }
    this.stop_talking_time = 0;
    this.start_talking_time = 0;
    this.vad = {
      ...(this.cs.vad || {}),
      strategy: 'continuous'
    };

    ep.startVadDetection(this.vad);
    this.isRunning = true;
  }

  _stopVad() {
    if (this.isRunning) {
      this.logger.warn('Latency calculator is still running, stopping VAD detection');
      const ep = this.cs.ep;
      ep.stopVadDetection(this.vad);
      if (ep.sttLatencyVadHandler) {
        this.ep?.removeCustomEventListener(VadDetection.Detection, ep.sttLatencyVadHandler);
        ep.sttLatencyVadHandler = null;
      }
      this.isRunning = false;
    }
  }

  start() {
    if (this.isRunning) {
      this.logger.warn('Latency calculator is already running');
      return;
    }
    if (!this.cs.ep) {
      this.logger.error('Callsession has no endpoint to start the latency calculator');
      return;
    }
    this._startVad();
    this.logger.info('STT Latency Calculator started');
  }

  stop() {
    this._stopVad();
    this.logger.info('STT Latency Calculator stopped');
  }

  toUnixTimestamp(date) {
    return Math.floor(date / 1000);
  }

  calculateLatency() {
    const stt_stop_time = this.cs.stt_stop_time || Date.now();
    const start_talking_time = this.talkspurts[0]?.start;
    const stop_talking_time = this.talkspurts[this.talkspurts.length - 1]?.stop;
    return {
      stt_start_time: this.toUnixTimestamp(this.cs.stt_start_time),
      stt_stop_time,
      start_talking_time: this.toUnixTimestamp(start_talking_time),
      stop_talking_time: this.toUnixTimestamp(stop_talking_time),
      stt_latency: parseFloat((stt_stop_time - stop_talking_time) / 1000).toFixed(2),
      stt_usage: parseFloat((stt_stop_time - this.cs.stt_start_time) / 1000).toFixed(2),
      talkspurts: this.talkspurts
    };
  }

  clearTalkspurts() {
    this.talkspurts = [];
    this.start_talking_time = 0;
  }
}

module.exports = SttLatencyCalculator;
