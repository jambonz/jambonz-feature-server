const assert = require('assert');
const TtsTask = require('./tts-task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const pollySSMLSplit = require('polly-ssml-split');
const { SpeechCredentialError } = require('../utils/error');

const breakLengthyTextIfNeeded = (logger,  text) => {
  const chunkSize = 1000;
  const isSSML = text.startsWith('<speak>');
  if (text.length <= chunkSize || !isSSML) return [text];
  const options = {
    // MIN length
    softLimit: 100,
    // MAX length, exclude 15 characters <speak></speak>
    hardLimit: chunkSize - 15,
    // Set of extra split characters (Optional property)
    extraSplitChars: ',;!?',
  };
  pollySSMLSplit.configure(options);
  try {
    return pollySSMLSplit.split(text);
  } catch (err) {
    logger.info({err}, 'Error spliting SSML long text');
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


    if (this.data.stream === true) {
      this._isStreamingTts = true;
      this.closeOnStreamEmpty = this.data.closeOnStreamEmpty !== false;
    }
    else {
      this._isStreamingTts = false;
      this.text = (Array.isArray(this.data.text) ? this.data.text : [this.data.text])
        .map((t) => breakLengthyTextIfNeeded(this.logger, t))
        .flat();

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
      if (this.isStreamingTts) await this.handlingStreaming(cs, obj);
      else await this.handling(cs, obj);
      this.emit('playDone');
    } catch (error) {
      if (error instanceof SpeechCredentialError) {
        // if say failed due to speech credentials, alarm is writtern and error notification is sent
        // finished this say to move to next task.
        this.logger.info({error}, 'Say failed due to SpeechCredentialError, finished!');
        this.emit('playDone');
        return;
      }
      throw error;
    }
  }

  async handlingStreaming(cs, {ep}) {
    const {vendor, voice, label} = this.getTtsVendorData(cs);
    const  credentials = cs.getSpeechCredentials(vendor, 'tts', label);
    if (!credentials) {
      throw new SpeechCredentialError(
        `No text-to-speech service credentials for ${vendor} with labels: ${label} have been configured`);
    }
    const {api_key} = credentials;

    // TODO: set channel variables for tts streaming vendor
    await ep.set({
      DEEPGRAM_API_KEY: api_key,
      DEEPGRAM_TTS_STREAMING_MODEL: voice
    });

    cs.requestor?.request('tts:streaming-event', '/streaming-event', {event_type: 'stream_open'})
      .catch((err) => this.logger.info({err}, 'TaskSay:handlingStreaming - Error sending'));

    await this.awaitTaskDone();
    cs.requestor?.request('tts:streaming-event', '/streaming-event', {event_type: 'stream_closed'})
      .catch((err) => this.logger.info({err}, 'TaskSay:handlingStreaming - Error sending'));

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
        if (cs.isInConference) {
          const {memberId, confName, confUuid} = cs;
          await this.playToConfMember(ep, memberId, confName, confUuid, filepath[segment]);
        }
        else {
          const isStreaming = filepath[segment].startsWith('say:{');
          if (isStreaming) {
            const arr = /^say:\{.*\}\s*(.*)$/.exec(filepath[segment]);
            if (arr) this.logger.debug(`Say:exec sending streaming tts request: ${arr[1].substring(0, 64)}..`);
          }
          else this.logger.debug(`Say:exec sending ${filepath[segment].substring(0, 64)}`);
          ep.once('playback-start', (evt) => {
            this.logger.debug({evt}, 'Say got playback-start');
            if (this.otelSpan) {
              this._addStreamingTtsAttributes(this.otelSpan, evt);
              this.otelSpan.end();
              this.otelSpan = null;
              if (evt.variable_tts_cache_filename) {
                cs.trackTmpFile(evt.variable_tts_cache_filename);
              }
            }
          });
          ep.once('playback-stop', (evt) => {
            this.logger.debug({evt}, 'Say got playback-stop');
            if (evt.variable_tts_error) {
              writeAlerts({
                account_sid,
                alert_type: AlertType.TTS_FAILURE,
                vendor,
                detail: evt.variable_tts_error,
                target_sid
              }).catch((err) => this.logger.info({err}, 'Error generating alert for no tts'));
            }
            if (evt.variable_tts_cache_filename && !this.killed) {
              const text = parseTextFromSayString(this.text[segment]);
              addFileToCache(evt.variable_tts_cache_filename, {
                account_sid,
                vendor,
                language,
                voice,
                engine,
                text
              }).catch((err) => this.logger.info({err}, 'Error adding file to cache'));
            }

            if (this._playResolve) {
              evt.variable_tts_error ? this._playReject(new Error(evt.variable_tts_error)) : this._playResolve();
            }
          });
          // wait for playback-stop event received to confirm if the playback is successful
          this._playPromise = new Promise((resolve, reject) => {
            this._playResolve = resolve;
            this._playReject = reject;
          });
          const r = await ep.play(filepath[segment]);
          this.logger.debug({r}, 'Say:exec play result');
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
          if (filepath[segment].startsWith('say:{')) {
            const arr = /^say:\{.*\}\s*(.*)$/.exec(filepath[segment]);
            if (arr) this.logger.debug(`Say:exec complete playing streaming tts request: ${arr[1].substring(0, 64)}..`);
          } else {
            // This log will print spech credentials in say command for tts stream mode
            this.logger.debug(`Say:exec completed play file ${filepath[segment]}`);
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
      }
      else {
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

  _addStreamingTtsAttributes(span, evt) {
    const attrs = {'tts.cached': false};
    for (const [key, value] of Object.entries(evt)) {
      if (key.startsWith('variable_tts_')) {
        let newKey = key.substring('variable_tts_'.length)
          .replace('whisper_', 'whisper.')
          .replace('deepgram_', 'deepgram.')
          .replace('playht_', 'playht.')
          .replace('rimelabs_', 'rimelabs.')
          .replace('verbio_', 'verbio.')
          .replace('elevenlabs_', 'elevenlabs.');
        if (spanMapping[newKey]) newKey = spanMapping[newKey];
        attrs[newKey] = value;
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
  // Rimelabs
  'rimelabs.name_lookup_time_ms': 'name_lookup_ms',
  'rimelabs.connect_time_ms': 'connect_ms',
  'rimelabs.final_response_time_ms': 'final_response_ms',
  // verbio
  'verbio.name_lookup_time_ms': 'name_lookup_ms',
  'verbio.connect_time_ms': 'connect_ms',
  'verbio.final_response_time_ms': 'final_response_ms',
};

module.exports = TaskSay;
