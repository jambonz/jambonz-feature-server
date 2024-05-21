const TtsTask = require('./tts-task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const pollySSMLSplit = require('polly-ssml-split');

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

    this.text = (Array.isArray(this.data.text) ? this.data.text : [this.data.text])
      .map((t) => breakLengthyTextIfNeeded(this.logger, t))
      .flat();

    this.loop = this.data.loop || 1;
    this.isHandledByPrimaryProvider = true;
  }

  get name() { return TaskName.Say; }

  get summary() {
    for (let i = 0; i < this.text.length; i++) {
      if (this.text[i].startsWith('silence_stream')) continue;
      return `${this.name}{text=${this.text[i].slice(0, 15)}${this.text[i].length > 15 ? '...' : ''}}`;
    }
    return `${this.name}{${this.text[0]}}`;
  }

  _validateURL(urlString) {
    try {
      new URL(urlString);
      return true;
    } catch (e) {
      return false;
    }
  }

  async _synthesizeWithSpecificVendor(cs, ep, {vendor, language, voice, label, preCache = false}) {
    const {srf, accountSid:account_sid} = cs;
    const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, srf);
    const {writeAlerts, AlertType, stats} = srf.locals;
    const {synthAudio} = srf.locals.dbHelpers;
    const engine = this.synthesizer.engine || 'standard';
    const salt = cs.callSid;

    let credentials = cs.getSpeechCredentials(vendor, 'tts', label);
    /* parse Nuance voices into name and model */
    let model;
    if (vendor === 'nuance' && voice) {
      const arr = /([A-Za-z-]*)\s+-\s+(enhanced|standard)/.exec(voice);
      if (arr) {
        voice = arr[1];
        model = arr[2];
      }
    } else if (vendor === 'deepgram') {
      model = voice;
    }

    /* allow for microsoft custom region voice and api_key to be specified as an override */
    if (vendor === 'microsoft' && this.options.deploymentId) {
      credentials = credentials || {};
      credentials.use_custom_tts = true;
      credentials.custom_tts_endpoint = this.options.deploymentId;
      credentials.api_key = this.options.apiKey || credentials.apiKey;
      credentials.region = this.options.region || credentials.region;
      voice = this.options.voice || voice;
    } else if (vendor === 'elevenlabs') {
      credentials = credentials || {};
      credentials.model_id = this.options.model_id || credentials.model_id;
      credentials.voice_settings = this.options.voice_settings || {};
      credentials.optimize_streaming_latency = this.options.optimize_streaming_latency
      || credentials.optimize_streaming_latency;
      voice = this.options.voice_id || voice;
    }

    ep.set({
      tts_engine: vendor,
      tts_voice: voice,
      cache_speech_handles: !cs.currentTtsVendor || cs.currentTtsVendor === vendor ? 1 : 0,
    }).catch((err) => this.logger.info({err}, 'Error setting tts_engine on endpoint'));
    // set the current vendor on the call session
    // If vendor is changed from the previous one, then reset the cache_speech_handles flag
    cs.currentTtsVendor = vendor;

    if (!preCache) this.logger.info({vendor, language, voice, model}, 'TaskSay:exec');
    try {
      if (!credentials) {
        writeAlerts({
          account_sid,
          alert_type: AlertType.TTS_NOT_PROVISIONED,
          vendor
        }).catch((err) => this.logger.info({err}, 'Error generating alert for no tts'));
        throw new Error('no provisioned speech credentials for TTS');
      }
      // synthesize all of the text elements
      let lastUpdated = false;

      /* produce an audio segment from the provided text */
      const generateAudio = async(text) => {
        if (this.killed) return;
        if (text.startsWith('silence_stream://')) return text;

        /* otel: trace time for tts */
        if (!preCache)  {
          const {span} = this.startChildSpan('tts-generation', {
            'tts.vendor': vendor,
            'tts.language': language,
            'tts.voice': voice
          });
          this.otelSpan = span;
        }
        try {
          const {filePath, servedFromCache, rtt} = await synthAudio(stats, {
            account_sid,
            text,
            vendor,
            language,
            voice,
            engine,
            model,
            salt,
            credentials,
            options: this.options,
            disableTtsCache : this.disableTtsCache,
            preCache
          });
          if (!filePath.startsWith('say:')) {
            this.logger.debug(`file ${filePath}, served from cache ${servedFromCache}`);
            if (filePath) cs.trackTmpFile(filePath);
            if (this.otelSpan) {
              this.otelSpan.setAttributes({'tts.cached': servedFromCache});
              this.otelSpan.end();
              this.otelSpan = null;
            }
            if (!servedFromCache && !lastUpdated) {
              lastUpdated = true;
              updateSpeechCredentialLastUsed(credentials.speech_credential_sid).catch(() => {/* logged error */});
            }
            if (!servedFromCache && rtt && !preCache) {
              this.notifyStatus({
                event: 'synthesized-audio',
                vendor,
                language,
                characters: text.length,
                elapsedTime: rtt
              });
            }
          }
          else {
            this.logger.debug('a streaming tts api will be used');
            const modifiedPath = filePath.replace('say:{', `say:{session-uuid=${ep.uuid},`);
            return modifiedPath;
          }
          return filePath;
        } catch (err) {
          this.logger.info({err}, 'Error synthesizing tts');
          if (this.otelSpan) this.otelSpan.end();
          writeAlerts({
            account_sid: cs.accountSid,
            alert_type: AlertType.TTS_FAILURE,
            vendor,
            detail: err.message
          }).catch((err) => this.logger.info({err}, 'Error generating alert for tts failure'));
          throw err;
        }
      };

      const arr = this.text.map((t) => (this._validateURL(t) ? t : generateAudio(t)));
      return (await Promise.all(arr)).filter((fp) => fp && fp.length);
    } catch (err) {
      this.logger.info(err, 'TaskSay:exec error');
      throw err;
    }

  }

  async exec(cs, {ep}) {
    const {srf, accountSid:account_sid} = cs;
    const {writeAlerts, AlertType} = srf.locals;
    const {addFileToCache} = srf.locals.dbHelpers;
    const engine = this.synthesizer.engine || 'standard';

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
    let label = this.synthesizer.label && this.synthesizer.label !== 'default' ?
      this.synthesizer.label :
      cs.speechSynthesisLabel;

    const fallbackVendor = this.synthesizer.fallbackVendor && this.synthesizer.fallbackVendor !== 'default' ?
      this.synthesizer.fallbackVendor :
      cs.fallbackSpeechSynthesisVendor;
    const fallbackLanguage = this.synthesizer.fallbackLanguage && this.synthesizer.fallbackLanguage !== 'default' ?
      this.synthesizer.fallbackLanguage :
      cs.fallbackSpeechSynthesisLanguage ;
    const fallbackVoice =  this.synthesizer.fallbackVoice && this.synthesizer.fallbackVoice !== 'default' ?
      this.synthesizer.fallbackVoice :
      cs.fallbackSpeechSynthesisVoice;
    const fallbackLabel = this.synthesizer.fallbackLabel && this.synthesizer.fallbackLabel !== 'default' ?
      this.synthesizer.fallbackLabel :
      cs.fallbackSpeechSynthesisLabel;

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
        throw error;
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
          if (filepath[segment].startsWith('say:{')) {
            const arr = /^say:\{.*\}\s*(.*)$/.exec(filepath[segment]);
            if (arr) this.logger.debug(`Say:exec sending streaming tts request: ${arr[1].substring(0, 64)}..`);
          }
          else this.logger.debug(`Say:exec sending  ${filepath[segment].substring(0, 64)}`);
          ep.once('playback-start', (evt) => {
            this.logger.debug({evt}, 'got playback-start');
            if (this.otelSpan) {
              this._addStreamingTtsAttributes(this.otelSpan, evt);
              this.otelSpan.end();
              this.otelSpan = null;
              if (evt.variable_tts_cache_filename) cs.trackTmpFile(evt.variable_tts_cache_filename);
            }
          });
          ep.once('playback-stop', (evt) => {
            this.logger.debug({evt}, 'got playback-stop');
            if (evt.variable_tts_error) {
              writeAlerts({
                account_sid,
                alert_type: AlertType.TTS_FAILURE,
                vendor,
                detail: evt.variable_tts_error
              }).catch((err) => this.logger.info({err}, 'Error generating alert for no tts'));
            }
            if (evt.variable_tts_cache_filename) {
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
          await ep.play(filepath[segment]);
          try {
            // wait for playback-stop event received to confirm if the playback is successful
            await this._playPromise;
          } catch (err) {
            try {
              await startFallback(err);
              continue;
            } catch (err) {
              this.logger.info({err}, 'Error waiting for playback-stop event');
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
    this.emit('playDone');
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
      if (this._playResolve) this._playResolve();
    }
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
          .replace('elevenlabs_', 'elevenlabs.');
        if (spanMapping[newKey]) newKey = spanMapping[newKey];
        attrs[newKey] = value;
      }
    }
    delete attrs['cache_filename']; //no value in adding this to the span
    span.setAttributes(attrs);
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
};

module.exports = TaskSay;
