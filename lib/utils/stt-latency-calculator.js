const { assert } = require('console');
const Emitter = require('events');
const {
  VadDetection,
  SileroVadDetection
} = require('../utils/constants.json');

class SttLatencyCalculator extends Emitter {
  constructor({ logger, cs}) {
    super();
    this.logger = logger;
    this.cs = cs;
    this.isRunning = false;
    this.isInTalkSpurt = false;
    this.start_talking_time = 0;
    this.talkspurts = [];
    this.vendor = this.cs.vad?.vendor || 'silero';
    this.stt_start_time = 0;
    this.stt_stop_time = 0;
    this.stt_on_transcription_time = 0;
  }

  set sttStartTime(time) {
    this.stt_start_time = time;
  }

  get sttStartTime() {
    return this.stt_start_time || 0;
  }

  set sttStopTime(time) {
    this.stt_stop_time = time;
  }

  get sttStopTime() {
    return this.stt_stop_time || 0;
  }

  set sttOnTranscriptionTime(time) {
    this.stt_on_transcription_time = time;
  }

  get sttOnTranscriptionTime() {
    return this.stt_on_transcription_time || 0;
  }

  _onVadDetected(_ep, _evt, fsEvent) {
    if (fsEvent.getHeader('detected-event') === 'stop_talking') {
      if (this.isInTalkSpurt) {
        this.talkspurts.push({
          start: this.start_talking_time,
          stop: Date.now()
        });
      }

      this.start_talking_time = 0;
      this.isInTalkSpurt = false;
    } else if (fsEvent.getHeader('detected-event') === 'start_talking') {
      this.start_talking_time = Date.now();
      this.isInTalkSpurt = true;
    }
  }

  _startVad() {
    assert(!this.isRunning, 'Latency calculator is already running');
    assert(this.cs.ep, 'Callsession has no endpoint to start the latency calculator');
    const ep = this.cs.ep;
    if (!ep.sttLatencyVadHandler) {
      ep.sttLatencyVadHandler = this._onVadDetected.bind(this, ep);
      if (this.vendor === 'silero') {
        ep.addCustomEventListener(SileroVadDetection.Detection, ep.sttLatencyVadHandler);
      } else {
        ep.addCustomEventListener(VadDetection.Detection, ep.sttLatencyVadHandler);
      }
    }
    this.stop_talking_time = 0;
    this.start_talking_time = 0;
    this.vad = {
      ...(this.cs.vad || {}),
      strategy: 'continuous',
      bugname: 'stt-latency-calculator-vad',
      vendor: this.vendor
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
        if (this.vendor === 'silero') {
          this.ep?.removeCustomEventListener(SileroVadDetection.Detection, ep.sttLatencyVadHandler);
        } else {
          this.ep?.removeCustomEventListener(VadDetection.Detection, ep.sttLatencyVadHandler);
        }
        ep.sttLatencyVadHandler = null;
      }
      this.isRunning = false;
      this.logger.info('STT Latency Calculator stopped');
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
    this.logger.debug('STT Latency Calculator started');
  }

  stop() {
    this._stopVad();
  }

  toUnixTimestamp(date) {
    return Math.floor(date / 1000);
  }

  calculateLatency() {
    if (!this.isRunning) {
      this.logger.debug('Latency calculator is not running, cannot calculate latency, returning default values');
      return null;
    }

    const stt_stop_time = this.stt_stop_time || Date.now();
    if (this.isInTalkSpurt) {
      this.talkspurts.push({
        start: this.start_talking_time,
        stop: stt_stop_time
      });
      this.isInTalkSpurt = false;
      this.start_talking_time = 0;
    }
    const stt_on_transcription_time = this.stt_on_transcription_time || stt_stop_time;
    const start_talking_time = this.talkspurts[0]?.start;
    let lastIdx = this.talkspurts.length - 1;
    lastIdx = lastIdx < 0 ? 0 : lastIdx;
    const stop_talking_time = this.talkspurts[lastIdx]?.stop || stt_stop_time;

    return {
      stt_start_time: this.toUnixTimestamp(this.stt_start_time),
      stt_stop_time: this.toUnixTimestamp(stt_stop_time),
      start_talking_time: this.toUnixTimestamp(start_talking_time),
      stop_talking_time: this.toUnixTimestamp(stop_talking_time),
      stt_latency: parseFloat((Math.abs(stt_on_transcription_time - stop_talking_time)) / 1000).toFixed(2),
      stt_latency_ms: Math.abs(stt_on_transcription_time - stop_talking_time),
      stt_usage: parseFloat((stt_stop_time - this.stt_start_time) / 1000).toFixed(2),
      talkspurts: this.talkspurts.map((ts) =>
        ([this.toUnixTimestamp(ts.start || 0), this.toUnixTimestamp(ts.stop || 0)]))
    };
  }

  resetTime() {
    if (!this.isRunning) {
      return;
    }
    this.stt_start_time = Date.now();
    this.stt_stop_time = 0;
    this.stt_on_transcription_time = 0;
    this.clearTalkspurts();
    this.logger.info('STT Latency Calculator reset');
  }

  onTranscriptionReceived() {
    if (!this.isRunning) {
      return;
    }
    this.stt_on_transcription_time = Date.now();
    this.logger.debug(`CallSession:on-transcription set to ${this.stt_on_transcription_time}`);
  }

  onTranscribeStop() {
    if (!this.isRunning) {
      return;
    }
    this.stt_stop_time = Date.now();
    this.logger.debug(`CallSession:transcribe-stop set to ${this.stt_stop_time}`);
  }

  clearTalkspurts() {
    this.talkspurts = [];
    if (!this.isInTalkSpurt) {
      this.start_talking_time = 0;
    }
  }
}

module.exports = SttLatencyCalculator;
