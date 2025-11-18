const assert = require('assert');
const TtsTask = require('./tts-task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const pollySSMLSplit = require('polly-ssml-split');
const { SpeechCredentialError } = require('../utils/error');
const { sleepFor } = require('../utils/helpers');

/**
 * Discard unmatching responses:
 * (1) I sent a playback id but get a response with a different playback id
 * (2) I sent a playback id but get a response with no playback id
 * (3) I did not send a playback id but get a response with a playback id
 * (4) I sent a cache file but get a response with a different cache file
 */

const isMatchingEvent = (logger, filename, playbackId, evt) => {

  if (!!playbackId && !!evt.variable_tts_playback_id && evt.variable_tts_playback_id === playbackId) {
    //logger.debug({filename, playbackId, evt}, 'Say:isMatchingEvent - playbackId matched');
    return true;
  }
  if (!!filename && !!evt.file && evt.file === filename) {
    //logger.debug({filename, playbackId, evt}, 'Say:isMatchingEvent - filename matched');
    return true;
  }
  logger.info({filename, playbackId, evt}, 'Say:isMatchingEvent - no match');
  return false;
};

const breakLengthyTextIfNeeded = (logger, text) => {
  // As The text can be used for tts streaming, we need to break lengthy text into smaller chunks
// HIGH_WATER_BUFFER_SIZE defined in tts-streaming-buffer.js
  const chunkSize = 900;
  const isSSML = text.startsWith('<speak>');
  const options = {
    softLimit: 100,
    hardLimit: chunkSize - 15,
    extraSplitChars: ',;!?',
  };
  pollySSMLSplit.configure(options);
  try {
    if (text.length <= chunkSize) return [text];
    if (isSSML) {
      return pollySSMLSplit.split(text);
    } else {
      // Wrap with <speak> and split
      const wrapped = `<speak>${text}</speak>`;
      const splitArr = pollySSMLSplit.split(wrapped);
      // Remove <speak> and </speak> from each chunk
      return splitArr.map((str) => str.replace(/^<speak>/, '').replace(/<\/speak>$/, ''));
    }
  } catch (err) {
    logger.info({err}, 'Error splitting SSML long text');
    return [text];
  }
};

const parseTextFromSayString = (text) => {
  const closingBraceIndex = text.indexOf('}');
  if (closingBraceIndex === -1) return text;
  return text.slice(closingBraceIndex + 1);
};

class TaskSay extends TtsTask {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    this.preconditions = TaskPreconditions.Endpoint;

    assert.ok((typeof this.data.text === 'string' || Array.isArray(this.data.text)) || this.data.stream === true,
      'Say: either text or stream:true is required');

    this.text = this.data.text ? (Array.isArray(this.data.text) ? this.data.text : [this.data.text])
      .map((t) => breakLengthyTextIfNeeded(this.logger, t))
      .flat() : [];

    if (this.data.stream === true) {
      this._isStreamingTts = true;
      this.closeOnStreamEmpty = this.data.closeOnStreamEmpty !== false;
    }
    else {
      this._isStreamingTts = false;
      this.loop = this.data.loop || 1;
      this.isHandledByPrimaryProvider = true;
    }
  }

  get name() { return TaskName.Say; }

  get summary() {
    if (this.isStreamingTts) return `${this.name} streaming`;
    else {
      for (let i = 0; i < this.text.length; i++) {
        if (this.text[i].startsWith('silence_stream')) continue;
        return `${this.name}{text=${this.text[i].slice(0, 15)}${this.text[i].length > 15 ? '...' : ''}}`;
      }
      return `${this.name}{${this.text[0]}}`;
    }
  }

  get isStreamingTts() { return this._isStreamingTts; }

  _validateURL(urlString) {
    try {
      new URL(urlString);
      return true;
    } catch (e) {
      return false;
    }
  }

  async exec(cs, obj) {
    if (this.isStreamingTts && !cs.appIsUsingWebsockets) {
      throw new Error('Say: streaming say verb requires applications to use the websocket API');
    }

    try {
      this._isStreamingTts = this._isStreamingTts || cs.autoStreamTts;
      if (this.isStreamingTts) {
        this.closeOnStreamEmpty = this.closeOnStreamEmpty || this.text.length !== 0;
      }
      if (this.isStreamingTts) await this.handlingStreaming(cs, obj);
      else await this.handling(cs, obj);
    } catch (error) {
      if (error instanceof SpeechCredentialError) {
        // if say failed due to speech credentials, alarm is writtern and error notification is sent
        // finished this say to move to next task.
        this.logger.info({error}, 'Say failed due to SpeechCredentialError, finished!');
        return;
      }
      throw error;
    }
  }

  async handlingStreaming(cs, {ep}) {
    const {vendor, language, voice, label} = this.getTtsVendorData(cs);
    const  credentials = cs.getSpeechCredentials(vendor, 'tts', label);
    if (!credentials) {
      throw new SpeechCredentialError(
        `No text-to-speech service credentials for ${vendor} with labels: ${label} have been configured`);
    }
    this.ep = ep;
    try {

      await this.setTtsStreamingChannelVars(vendor, language, voice, credentials, ep);

      await cs.startTtsStream();

      if (this.text.length !== 0) {
        this.logger.info('TaskSay:handlingStreaming - sending text to TTS stream');
        for (const t of this.text) {
          const result = await cs._internalTtsStreamingBufferTokens(t);
          if (result?.status === 'failed') {
            if (result.reason === 'full') {
              // Retry logic for full buffer
              const maxRetries = 5;
              let backoffMs = 1000;
              for (let retryCount = 0; retryCount < maxRetries && !this.killed; retryCount++) {
                this.logger.info(
                  `TaskSay:handlingStreaming - retry ${retryCount + 1}/${maxRetries} after ${backoffMs}ms`);
                await sleepFor(backoffMs);

                const retryResult = await cs._internalTtsStreamingBufferTokens(t);

                // Exit retry loop on success
                if (retryResult?.status !== 'failed') {
                  break;
                }

                // Handle failure for reason other than full buffer
                if (retryResult.reason !== 'full') {
                  this.logger.info(
                    {result: retryResult}, 'TaskSay:handlingStreaming - TTS stream failed to buffer tokens');
                  throw new Error(`TTS stream failed to buffer tokens: ${retryResult.reason}`);
                }

                // Last retry attempt failed
                if (retryCount === maxRetries - 1) {
                  this.logger.info('TaskSay:handlingStreaming - Maximum retries exceeded for full buffer');
                  throw new Error('TTS stream buffer full - maximum retries exceeded');
                }

                // Increase backoff for next retry
                backoffMs = Math.min(backoffMs * 1.5, 10000);
              }
            } else {
              // Immediate failure for non-full buffer issues
              this.logger.info({result}, 'TaskSay:handlingStreaming - TTS stream failed to buffer tokens');
              throw new Error(`TTS stream failed to buffer tokens: ${result.reason}`);
            }
          } else {
            await cs._lccTtsFlush();
          }
        }
      }
    } catch (err) {
      this.logger.info({err}, 'TaskSay:handlingStreaming - Error setting channel vars');
      cs.requestor?.request('tts:streaming-event', '/streaming-event', {event_type: 'stream_closed'})
        .catch((err) => this.logger.info({err}, 'TaskSay:handlingStreaming - Error sending'));

      //TODO: send tts:streaming-event with error?
      this.notifyTaskDone();
    }

    await this.awaitTaskDone();
    this.logger.info('TaskSay:handlingStreaming - done');
  }

  async handling(cs, {ep}) {
    const {srf, accountSid:account_sid, callSid:target_sid} = cs;
    const {writeAlerts, AlertType} = srf.locals;
    const {addFileToCache} = srf.locals.dbHelpers;
    const engine = this.synthesizer.engine || cs.synthesizer?.engine || 'neural';

    await super.exec(cs);
    this.ep = ep;

    let vendor = this.synthesizer.vendor && this.synthesizer.vendor !== 'default' ?
      this.synthesizer.vendor :
      cs.speechSynthesisVendor;
    let language = this.synthesizer.language && this.synthesizer.language !== 'default' ?
      this.synthesizer.language :
      cs.speechSynthesisLanguage ;
    let voice =  this.synthesizer.voice && this.synthesizer.voice !== 'default' ?
      this.synthesizer.voice :
      cs.speechSynthesisVoice;
    let label = this.taskIncludeSynthesizer ? this.synthesizer.label : cs.speechSynthesisLabel;

    const fallbackVendor = this.synthesizer.fallbackVendor && this.synthesizer.fallbackVendor !== 'default' ?
      this.synthesizer.fallbackVendor :
      cs.fallbackSpeechSynthesisVendor;
    const fallbackLanguage = this.synthesizer.fallbackLanguage && this.synthesizer.fallbackLanguage !== 'default' ?
      this.synthesizer.fallbackLanguage :
      cs.fallbackSpeechSynthesisLanguage ;
    const fallbackVoice =  this.synthesizer.fallbackVoice && this.synthesizer.fallbackVoice !== 'default' ?
      this.synthesizer.fallbackVoice :
      cs.fallbackSpeechSynthesisVoice;
    const fallbackLabel = this.taskIncludeSynthesizer ?
      this.synthesizer.fallbackLabel : cs.fallbackSpeechSynthesisLabel;

    if (cs.hasFallbackTts) {
      vendor = fallbackVendor;
      language = fallbackLanguage;
      voice = fallbackVoice;
      label = fallbackLabel;
    }

    const startFallback = async(error) => {
      if (fallbackVendor && this.isHandledByPrimaryProvider && !cs.hasFallbackTts) {
        this.notifyError(
          { msg: 'TTS error', details:`TTS vendor ${vendor} error: ${error}`, failover: 'in progress'});
        this.isHandledByPrimaryProvider = false;
        cs.hasFallbackTts = true;
        this.logger.info(`Synthesize error, fallback to ${fallbackVendor}`);
        filepath = await this._synthesizeWithSpecificVendor(cs, ep,
          {
            vendor: fallbackVendor,
            language: fallbackLanguage,
            voice: fallbackVoice,
            label: fallbackLabel
          });
      } else {
        this.notifyError(
          { msg: 'TTS error', details:`TTS vendor ${vendor} error: ${error}`, failover: 'not available'});
        throw new SpeechCredentialError(error.message);
      }
    };

    let filepath;
    try {
      filepath = await this._synthesizeWithSpecificVendor(cs, ep, {vendor, language, voice, label});
    } catch (error) {
      await startFallback(error);
    }
    this.notifyStatus({event: 'start-playback'});

    while (!this.killed && (this.loop === 'forever' || this.loop--) && ep?.connected) {
      let segment = 0;
      while (!this.killed && segment < filepath.length) {
        const filename = filepath[segment];
        if (cs.isInConference) {
          const {memberId, confName, confUuid} = cs;
          await this.playToConfMember(ep, memberId, confName, confUuid, filename);
        }
        else {
          const isStreaming = filename.startsWith('say:{');
          if (isStreaming) {
            const arr = /^say:\{.*\}\s*(.*)$/.exec(filename);
            if (arr) this.logger.debug(`Say:exec sending streaming tts request ${arr[1].substring(0, 64)}..`);
            else this.logger.debug(`Say:exec sending ${filename.substring(0, 64)}`);
          }

          const onPlaybackStop = (evt) => {
            try {
              const playbackId = this.getPlaybackId(segment);
              const isMatch = isMatchingEvent(this.logger, filename, playbackId, evt);
              if (!isMatch) {
                this.logger.info({currentPlaybackId: playbackId, stopPlaybackId: evt.variable_tts_playback_id},
                  'Say:exec discarding playback-stop for earlier play');
                ep.once('playback-stop',  this._boundOnPlaybackStop);

                return;
              }
              this.logger.debug({evt},
                `Say got playback-stop ${evt.variable_tts_playback_id ? evt.variable_tts_playback_id : ''}`);
              this.notifyStatus({event: 'stop-playback'});
              this.notifiedPlayBackStop = true;
              const tts_error = evt.variable_tts_error;
              // some tts vendor may not provide response code, so we default to 200
              let response_code = 200;
              // Check if any property ends with _response_code
              for (const [key, value] of Object.entries(evt)) {
                if (key.endsWith('_response_code')) {
                  response_code = parseInt(value, 10);
                  if (isNaN(response_code)) {
                    this.logger.info(`Say:exec playback-stop - Invalid response code: ${value}`);
                    response_code = 0;
                  }
                  break;
                }
              }

              if (tts_error ||
                // error response codes indicate failure
                response_code <= 199 || response_code >= 300) {
                writeAlerts({
                  account_sid,
                  alert_type: AlertType.TTS_FAILURE,
                  vendor,
                  detail: evt.variable_tts_error || `TTS playback failed with response code ${response_code}`,
                  target_sid
                }).catch((err) => this.logger.info({err}, 'Error generating alert for no tts'));
              }
              if (
                !tts_error &&
                //2xx response codes indicate success
                199 < response_code && response_code < 300 &&
                evt.variable_tts_cache_filename &&
                !this.killed &&
                // if tts cache is not disabled, add the file to cache
                !this.disableTtsCache
              ) {
                const text = parseTextFromSayString(this.text[segment]);
                this.logger.debug({text, cacheFile: evt.variable_tts_cache_filename}, 'Say:exec cache tts');
                addFileToCache(evt.variable_tts_cache_filename, {
                  account_sid,
                  vendor,
                  language,
                  voice,
                  engine,
                  model: this.model || this.model_id,
                  text,
                  instructions: this.instructions
                }).catch((err) => this.logger.info({err}, 'Error adding file to cache'));
              }

              if (this._playResolve) {
                (tts_error ||
                  // error response codes indicate failure
                  response_code <= 199 || response_code >= 300
                ) ?
                  this._playReject(
                    new Error(evt.variable_tts_error || `TTS playback failed with response code ${response_code}`)
                  ) : this._playResolve();
              }
            } catch (err) {
              this.logger.info({err}, 'Error handling playback-stop event');
            }
          };
          this._boundOnPlaybackStop = onPlaybackStop.bind(this);

          const onPlaybackStart = (evt) => {
            try {
              const playbackId = this.getPlaybackId(segment);
              const isMatch = isMatchingEvent(this.logger, filename, playbackId, evt);
              if (!isMatch) {
                this.logger.info({currentPlaybackId: playbackId, startPlaybackId: evt.variable_tts_playback_id},
                  'Say:exec playback-start - unmatched playback_id');
                ep.once('playback-start',  this._boundOnPlaybackStart);
                return;
              }
              ep.once('playback-stop',  this._boundOnPlaybackStop);
              this.logger.debug({evt},
                `Say got playback-start ${evt.variable_tts_playback_id ? evt.variable_tts_playback_id : ''}`);
              if (this.otelSpan) {
                this._addStreamingTtsAttributes(this.otelSpan, evt, vendor);
                this.otelSpan.end();
                this.otelSpan = null;
                if (evt.variable_tts_cache_filename) {
                  cs.trackTmpFile(evt.variable_tts_cache_filename);
                }
              }
            } catch (err) {
              this.logger.info({err}, 'Error handling playback-start event');
            }
          };
          this._boundOnPlaybackStart = onPlaybackStart.bind(this);

          ep.once('playback-start',  this._boundOnPlaybackStart);

          // wait for playback-stop event received to confirm if the playback is successful
          this._playPromise = new Promise((resolve, reject) => {
            this._playResolve = resolve;
            this._playReject = reject;
          });
          const r = await ep.play(filename);
          this.logger.debug({r}, 'Say:exec play result');
          if (r.playbackSeconds == null && r.playbackMilliseconds == null && r.playbackLastOffsetPos == null) {
            this._playReject(new Error('Playback failed to start'));
          }
          try {
            // wait for playback-stop event received to confirm if the playback is successful
            await this._playPromise;
          } catch (err) {
            try {
              await startFallback(err);
              continue;
            } catch (err) {
              this.logger.info({err}, 'Error waiting for playback-stop event');
              throw err;
            }
          } finally {
            this._playPromise = null;
            this._playResolve = null;
            this._playReject = null;
          }
          if (filename.startsWith('say:{')) {
            const arr = /^say:\{.*\}\s*(.*)$/.exec(filename);
            if (arr) this.logger.debug(`Say:exec complete playing streaming tts request: ${arr[1].substring(0, 64)}..`);
          } else {
            // This log will print spech credentials in say command for tts stream mode
            this.logger.debug(`Say:exec completed play file ${filename}`);
          }
        }
        segment++;
      }
    }
  }

  async kill(cs) {
    super.kill(cs);
    if (this.ep?.connected) {
      this.logger.debug('TaskSay:kill - killing audio');
      if (cs.isInConference) {
        const {memberId, confName} = cs;
        this.killPlayToConfMember(this.ep, memberId, confName);
      } else if (this.isStreamingTts) {
        this.logger.debug('TaskSay:kill - stopping TTS stream for streaming audio');
        cs.stopTtsStream();
      } else {
        if (!this.notifiedPlayBackStop) {
          this.notifyStatus({event: 'stop-playback'});
        }
        this.notifyStatus({event: 'kill-playback'});
        this.ep.api('uuid_break', this.ep.uuid);
      }
      this.ep.removeAllListeners('playback-start');
      this.ep.removeAllListeners('playback-stop');
      // if we are waiting for playback-stop event, resolve the promise
      if (this._playResolve) {
        this._playResolve();
        this._playResolve = null;
      }
    }
    this.notifyTaskDone();
  }

  _addStreamingTtsAttributes(span, evt, vendor) {
    const attrs = {'tts.cached': false};
    for (const [key, value] of Object.entries(evt)) {
      if (key.startsWith('variable_tts_')) {
        let newKey = key.substring('variable_tts_'.length)
          .replace('whisper_', 'whisper.')
          .replace('nvidia_', 'nvidia.')
          .replace('deepgram_', 'deepgram.')
          .replace('playht_', 'playht.')
          .replace('cartesia_', 'cartesia.')
          .replace('rimelabs_', 'rimelabs.')
          .replace('resemble_', 'resemble.')
          .replace('inworld_', 'inworld.')
          .replace('verbio_', 'verbio.')
          .replace('elevenlabs_', 'elevenlabs.');
        if (spanMapping[newKey]) newKey = spanMapping[newKey];
        attrs[newKey] = value;
        if (key === 'variable_tts_time_to_first_byte_ms' && value) {
          this.cs.srf.locals.stats.histogram('tts.response_time', value, [`vendor:${vendor}`]);
        }
      }
    }
    delete attrs['cache_filename']; //no value in adding this to the span
    span.setAttributes(attrs);
  }

  notifyTtsStreamIsEmpty() {
    if (this.isStreamingTts && this.closeOnStreamEmpty) {
      this.logger.info('TaskSay:notifyTtsStreamIsEmpty - stream is empty, killing task');
      this.notifyTaskDone();
    }
  }
}

const spanMapping = {
  // IMPORTANT!!! JAMBONZ WEBAPP WILL SHOW TEXT PERFECTLY IF THE SPAN NAME IS SMALLER OR EQUAL 25 CHARACTERS.
  // EX: whisper.ratelim_reqs has length 20 <= 25 which is perfect
  // Elevenlabs
  'elevenlabs.reported_latency_ms': 'elevenlabs.latency_ms',
  'elevenlabs.request_id': 'elevenlabs.req_id',
  'elevenlabs.history_item_id': 'elevenlabs.item_id',
  'elevenlabs.optimize_streaming_latency': 'elevenlabs.optimization',
  'elevenlabs.name_lookup_time_ms': 'name_lookup_ms',
  'elevenlabs.connect_time_ms': 'connect_ms',
  'elevenlabs.final_response_time_ms': 'final_response_ms',
  // Whisper
  'whisper.reported_latency_ms': 'whisper.latency_ms',
  'whisper.request_id': 'whisper.req_id',
  'whisper.reported_organization': 'whisper.organization',
  'whisper.reported_ratelimit_requests': 'whisper.ratelimit',
  'whisper.reported_ratelimit_remaining_requests': 'whisper.ratelimit_remain',
  'whisper.reported_ratelimit_reset_requests': 'whisper.ratelimit_reset',
  'whisper.name_lookup_time_ms': 'name_lookup_ms',
  'whisper.connect_time_ms': 'connect_ms',
  'whisper.final_response_time_ms': 'final_response_ms',
  // Deepgram
  'deepgram.request_id': 'deepgram.req_id',
  'deepgram.reported_model_name': 'deepgram.model_name',
  'deepgram.reported_model_uuid': 'deepgram.model_uuid',
  'deepgram.reported_char_count': 'deepgram.char_count',
  'deepgram.name_lookup_time_ms': 'name_lookup_ms',
  'deepgram.connect_time_ms': 'connect_ms',
  'deepgram.final_response_time_ms': 'final_response_ms',
  // Playht
  'playht.request_id': 'playht.req_id',
  'playht.name_lookup_time_ms': 'name_lookup_ms',
  'playht.connect_time_ms': 'connect_ms',
  'playht.final_response_time_ms': 'final_response_ms',
  // Cartesia
  'cartesia.request_id': 'cartesia.req_id',
  'cartesia.name_lookup_time_ms': 'name_lookup_ms',
  'cartesia.connect_time_ms': 'connect_ms',
  'cartesia.final_response_time_ms': 'final_response_ms',
  // Rimelabs
  'rimelabs.name_lookup_time_ms': 'name_lookup_ms',
  'rimelabs.connect_time_ms': 'connect_ms',
  'rimelabs.final_response_time_ms': 'final_response_ms',
  // Resemble
  'resemble.connect_time_ms': 'connect_ms',
  'resemble.final_response_time_ms': 'final_response_ms',
  // inworld
  'inworld.name_lookup_time_ms': 'name_lookup_ms',
  'inworld.connect_time_ms': 'connect_ms',
  'inworld.final_response_time_ms': 'final_response_ms',
  'inworld.x_envoy_upstream_service_time': 'upstream_service_time',
  // verbio
  'verbio.name_lookup_time_ms': 'name_lookup_ms',
  'verbio.connect_time_ms': 'connect_ms',
  'verbio.final_response_time_ms': 'final_response_ms',
};

module.exports = TaskSay;
