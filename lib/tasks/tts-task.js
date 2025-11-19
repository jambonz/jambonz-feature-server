const Task = require('./task');
const { TaskPreconditions } = require('../utils/constants');
const { SpeechCredentialError } = require('../utils/error');
const dbUtils = require('../utils/db-utils');

const extractPlaybackId = (str) => {
  // Match say:{...} and capture the content inside braces
  const match = str.match(/say:\{([^}]*)\}/);
  if (!match) return null;

  // Look for playback_id=value within the captured content
  const playbackMatch = match[1].match(/playback_id=([^,]*)/);
  return playbackMatch ? playbackMatch[1] : null;
};

class TtsTask extends Task {

  constructor(logger, data, parentTask) {
    super(logger, data);
    this.parentTask = parentTask;

    this.preconditions = TaskPreconditions.Endpoint;

    this.earlyMedia = this.data.earlyMedia === true || (parentTask && parentTask.earlyMedia);
    /**
     * Task use taskIncludeSynthesizer to identify
     * if taskIncludeSynthesizer === true, use label from verb.synthesizer, even it's empty
     * if taskIncludeSynthesizer === false, use label from application.synthesizer
     */
    this.taskIncludeSynthesizer = !!this.data.synthesizer;
    this.synthesizer = this.data.synthesizer || {};
    this.disableTtsCache = this.data.disableTtsCache;
    this.options = this.synthesizer.options || {};
    this.instructions = this.data.instructions;
    this.playbackIds = [];
  }

  getPlaybackId(offset) {
    return this.playbackIds[offset];
  }

  async exec(cs) {
    super.exec(cs);
    // update disableTtsCache from call session if not set in task
    if (this.data.disableTtsCache == null) {
      this.disableTtsCache = cs.disableTtsCache;
    }
    if (cs.synthesizer) {
      this.options = {...cs.synthesizer.options, ...this.options};
      this.data.synthesizer = this.data.synthesizer || {};
      for (const k in cs.synthesizer) {
        const newValue = this.data.synthesizer && this.data.synthesizer[k] !== undefined ?
          this.data.synthesizer[k] :
          cs.synthesizer[k];

        if (Array.isArray(newValue)) {
          this.data.synthesizer[k] = [...(this.data.synthesizer[k] || []), ...cs.synthesizer[k]];
        } else if (typeof newValue === 'object' && newValue !== null) {
          this.data.synthesizer[k] = { ...(this.data.synthesizer[k] || {}), ...cs.synthesizer[k] };
        } else {
          this.data.synthesizer[k] = newValue;
        }
      }
    }

    const fullText = Array.isArray(this.text) ? this.text.join(' ') : this.text;
    // in case dub verb, text might not be set.
    if (fullText?.length > 0) {
      cs.emit('botSaid', fullText);
    }
  }

  getTtsVendorData(cs) {
    const vendor = this.synthesizer.vendor && this.synthesizer.vendor !== 'default' ?
      this.synthesizer.vendor :
      cs.speechSynthesisVendor;
    const language = this.synthesizer.language && this.synthesizer.language !== 'default' ?
      this.synthesizer.language :
      cs.speechSynthesisLanguage ;
    const voice =  this.synthesizer.voice && this.synthesizer.voice !== 'default' ?
      this.synthesizer.voice :
      cs.speechSynthesisVoice;
    const label = this.taskIncludeSynthesizer ? this.synthesizer.label : cs.speechSynthesisLabel;
    return {vendor, language, voice, label};
  }

  async setTtsStreamingChannelVars(vendor, language, voice, credentials, ep) {
    const {api_key, model_id, api_uri, custom_tts_streaming_url, auth_token, options} = credentials;
    // api_key, model_id, api_uri, custom_tts_streaming_url, and auth_token are encoded in the credentials
    // allow them to be overriden via config, using options
    // give preference to options passed in via config
    const parsed_options = JSON.parse(options ?? '{}');
    const local_options = {...parsed_options, ...this.options ?? {}};
    const local_voice_settings = {...parsed_options.voice_settings ?? {}, ...this.options?.voice_settings ?? {}};
    const local_api_key =  local_options.api_key ?? api_key;
    const local_model_id = local_options.model_id ?? model_id;
    const local_api_uri = local_options.api_uri ?? api_uri;
    const local_custom_tts_streaming_url = local_options.custom_tts_streaming_url ?? custom_tts_streaming_url;
    const local_auth_token = local_options.auth_token ?? auth_token;


    let obj;

    switch (vendor) {
      case 'deepgram':
        obj = {
          DEEPGRAM_API_KEY: local_api_key,
          DEEPGRAM_TTS_STREAMING_MODEL: voice
        };
        break;
      case 'cartesia':
        obj = {
          CARTESIA_API_KEY: local_api_key,
          CARTESIA_TTS_STREAMING_MODEL_ID: local_model_id,
          CARTESIA_TTS_STREAMING_VOICE_ID: voice,
          CARTESIA_TTS_STREAMING_LANGUAGE: language || 'en',
        };
        break;
      case 'elevenlabs':
        // eslint-disable-next-line max-len
        const {stability, similarity_boost, use_speaker_boost, style, speed} = local_voice_settings || {};
        obj = {
          ELEVENLABS_API_KEY: local_api_key,
          ...(api_uri && {ELEVENLABS_API_URI: local_api_uri}),
          ELEVENLABS_TTS_STREAMING_MODEL_ID: local_model_id,
          ELEVENLABS_TTS_STREAMING_VOICE_ID: voice,
          // 20/12/2024 - only eleven_turbo_v2_5 support multiple language
          ...(['eleven_turbo_v2_5'].includes(local_model_id) && {ELEVENLABS_TTS_STREAMING_LANGUAGE: language}),
          ...(stability && {ELEVENLABS_TTS_STREAMING_VOICE_SETTINGS_STABILITY: stability}),
          ...(similarity_boost && {ELEVENLABS_TTS_STREAMING_VOICE_SETTINGS_SIMILARITY_BOOST: similarity_boost}),
          ...(use_speaker_boost && {ELEVENLABS_TTS_STREAMING_VOICE_SETTINGS_USE_SPEAKER_BOOST: use_speaker_boost}),
          ...(style && {ELEVENLABS_TTS_STREAMING_VOICE_SETTINGS_STYLE: style}),
          // speed has value 0.7 to 1.2, 1.0 is default, make sure we send the value event it's 0
          ...(speed !== null && speed !== undefined && {ELEVENLABS_TTS_STREAMING_VOICE_SETTINGS_SPEED: `${speed}`}),
          ...(local_options.pronunciation_dictionary_locators &&
            Array.isArray(local_options.pronunciation_dictionary_locators) && {
            ELEVENLABS_TTS_STREAMING_PRONUNCIATION_DICTIONARY_LOCATORS:
            JSON.stringify(local_options.pronunciation_dictionary_locators)
          }),
        };
        break;
      case 'rimelabs':
        const {
          pauseBetweenBrackets, phonemizeBetweenBrackets, inlineSpeedAlpha, speedAlpha, reduceLatency
        } = local_options;
        obj = {
          RIMELABS_API_KEY: local_api_key,
          RIMELABS_TTS_STREAMING_MODEL_ID: local_model_id,
          RIMELABS_TTS_STREAMING_VOICE_ID: voice,
          RIMELABS_TTS_STREAMING_LANGUAGE: language || 'en',
          ...(pauseBetweenBrackets && {RIMELABS_TTS_STREAMING_PAUSE_BETWEEN_BRACKETS: pauseBetweenBrackets}),
          ...(phonemizeBetweenBrackets &&
            {RIMELABS_TTS_STREAMING_PHONEMIZE_BETWEEN_BRACKETS: phonemizeBetweenBrackets}),
          ...(inlineSpeedAlpha && {RIMELABS_TTS_STREAMING_INLINE_SPEED_ALPHA: inlineSpeedAlpha}),
          ...(speedAlpha && {RIMELABS_TTS_STREAMING_SPEED_ALPHA: speedAlpha}),
          ...(reduceLatency && {RIMELABS_TTS_STREAMING_REDUCE_LATENCY: reduceLatency})
        };
        break;
      default:
        if (vendor.startsWith('custom:')) {
          const use_tls = custom_tts_streaming_url.startsWith('wss://');
          obj = {
            CUSTOM_TTS_STREAMING_HOST: local_custom_tts_streaming_url.replace(/^(ws|wss):\/\//, ''),
            CUSTOM_TTS_STREAMING_API_KEY: local_auth_token,
            CUSTOM_TTS_STREAMING_VOICE_ID: voice,
            CUSTOM_TTS_STREAMING_LANGUAGE: language || 'en',
            CUSTOM_TTS_STREAMING_USE_TLS: use_tls
          };
        } else {
          throw new Error(`vendor ${vendor} is not supported for tts streaming yet`);
        }
    }
    this.logger.debug({vendor, credentials, obj}, 'setTtsStreamingChannelVars');

    await ep.set(obj);
  }

  async _synthesizeWithSpecificVendor(cs, ep, {vendor, language, voice, label, preCache = false}) {
    const {srf, accountSid:account_sid} = cs;
    const {writeAlerts, AlertType, stats} = srf.locals;
    const {synthAudio} = srf.locals.dbHelpers;
    const engine = this.synthesizer.engine || cs.synthesizer?.engine || 'neural';
    const salt = cs.callSid;

    let credentials = cs.getSpeechCredentials(vendor, 'tts', label);
    if (!credentials) {
      throw new SpeechCredentialError(
        `No text-to-speech service credentials for ${vendor} with labels: ${label} have been configured`);
    }
    /* parse Nuance voices into name and model */
    if (vendor === 'nuance' && voice) {
      const arr = /([A-Za-z-]*)\s+-\s+(enhanced|standard)/.exec(voice);
      if (arr) {
        voice = arr[1];
        this.model = arr[2];
      }
    } else if (vendor === 'deepgram') {
      this.model = voice;
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
    } else if (vendor === 'rimelabs') {
      credentials = credentials || {};
      credentials.model_id = this.options.model_id || credentials.model_id;
    } else if (vendor === 'inworld') {
      credentials = credentials || {};
      credentials.model_id = this.options.model_id || credentials.model_id;
    } else if (vendor === 'whisper') {
      credentials = credentials || {};
      credentials.model_id = this.options.model_id || credentials.model_id;
    } else if (vendor === 'verbio') {
      credentials = credentials || {};
      credentials.engine_version = this.options.engine_version || credentials.engine_version;
    } else if (vendor === 'playht') {
      credentials = credentials || {};
      credentials.voice_engine = this.options.voice_engine || credentials.voice_engine;
    } else if (vendor === 'google' && typeof voice === 'string' && voice.startsWith('custom_')) {
      const {lookupGoogleCustomVoice} = dbUtils(this.logger, cs.srf);
      const arr = /custom_(.*)/.exec(voice);
      if (arr) {
        const google_custom_voice_sid = arr[1];
        const [custom_voice] = await lookupGoogleCustomVoice(google_custom_voice_sid);
        if (custom_voice.use_voice_cloning_key) {
          voice = {
            voice_cloning_key: custom_voice.voice_cloning_key,
          };
        }
      }
    } else if (vendor === 'cartesia') {
      credentials.model_id = this.options.model_id || credentials.model_id;
    }

    this.model_id = credentials.model_id;

    /**
     * note on cache_speech_handles.  This was found to be risky.
     * It can cause a crash in the following sequence on a single call:
     * 1. Stream tts on vendor A with cache_speech_handles=1, then
     * 2. Stream tts on vendor B with cache_speech_handles=1
     *
     * we previously tried to track when vendors were switched and manage the flag accordingly,
     * but it difficult to track all the scenarios and the benefit (slightly faster start to tts playout)
     * is probably minimal.  DH.
     */
    ep.set({
      tts_engine: vendor.startsWith('custom:') ? 'custom' : vendor,
      tts_voice: voice,
      //cache_speech_handles: !cs.currentTtsVendor || cs.currentTtsVendor === vendor ? 1 : 0,
      cache_speech_handles: 0,
    }).catch((err) => this.logger.info({err}, 'Error setting tts_engine on endpoint'));
    // set the current vendor on the call session
    // If vendor is changed from the previous one, then reset the cache_speech_handles flag
    //cs.currentTtsVendor = vendor;

    if (!preCache && !this._disableTracing)
      this.logger.debug({vendor, language, voice, model: this.model}, 'TaskSay:exec');
    try {
      if (!credentials) {
        writeAlerts({
          account_sid,
          alert_type: AlertType.TTS_NOT_PROVISIONED,
          vendor,
          target_sid: cs.callSid
        }).catch((err) => this.logger.info({err}, 'Error generating alert for no tts'));
        throw new SpeechCredentialError('no provisioned speech credentials for TTS');
      }

      /* produce an audio segment from the provided text */
      const generateAudio = async(text, index) => {
        if (this.killed) return {index, filePath: null};
        if (text.startsWith('silence_stream://')) return {index, filePath: text};

        /* otel: trace time for tts */
        if (!preCache && !this._disableTracing)  {
          const {span} = this.startChildSpan('tts-generation', {
            'tts.vendor': vendor,
            'tts.language': language,
            'tts.voice': voice,
            'tts.label': label || 'None',
          });
          this.otelSpan = span;
        }
        try {
          const {filePath, servedFromCache, rtt} = await synthAudio(stats, {
            account_sid,
            text,
            instructions: this.instructions,
            vendor,
            language,
            voice,
            engine,
            model: this.model,
            salt,
            credentials,
            options: this.options,
            disableTtsCache : this.disableTtsCache,
            renderForCaching: preCache
          });
          if (!filePath.startsWith('say:')) {
            this.logger.debug(`Say: file ${filePath}, served from cache ${servedFromCache}`);
            if (filePath) cs.trackTmpFile(filePath);
            if (this.otelSpan) {
              this.otelSpan.setAttributes({'tts.cached': servedFromCache});
              this.otelSpan.end();
              this.otelSpan = null;
            }
            if (!servedFromCache && rtt && !preCache  && !this._disableTracing) {
              this.notifyStatus({
                event: 'synthesized-audio',
                vendor,
                language,
                characters: text.length,
                elapsedTime: rtt,
                servedFromCache,
                'id': this.id
              });
            }
            if (servedFromCache) {
              this.notifyStatus({
                event: 'synthesized-audio',
                vendor,
                language,
                servedFromCache,
                'id': this.id
              });
            }
            return {index, filePath, playbackId: null};
          }
          else {
            const playbackId = extractPlaybackId(filePath);
            this.logger.debug('Say: a streaming tts api will be used');
            const modifiedPath = filePath.replace('say:{', `say:{session-uuid=${ep.uuid},`);
            this.notifyStatus({
              event: 'synthesized-audio',
              vendor,
              language,
              servedFromCache,
              'id': this.id
            });
            return {index, filePath: modifiedPath, playbackId};
          }
        } catch (err) {
          this.logger.info({err}, 'Error synthesizing tts');
          if (this.otelSpan) this.otelSpan.end();
          writeAlerts({
            account_sid: cs.accountSid,
            alert_type: AlertType.TTS_FAILURE,
            vendor,
            detail: err.message,
            target_sid: cs.callSid
          }).catch((err) => this.logger.info({err}, 'Error generating alert for tts failure'));
          throw err;
        }
      };

      // process all text segments in parallel will cause ordering issue
      // so we attach index to each promise result and sort them later

      const arr = this.text.map((t, index) => (this._validateURL(t) ?
        Promise.resolve({index, filePath: t, playbackId: null}) : generateAudio(t, index)));
      const results = await Promise.all(arr);
      const sorted = results.sort((a, b) => a.index - b.index);

      return sorted
        .filter((fp) => fp.filePath && fp.filePath.length)
        .map((r) => {
          this.playbackIds.push(r.playbackId);
          return r.filePath;
        });
    } catch (err) {
      this.logger.info(err, 'TaskSay:exec error');
      throw err;
    }

  }

  _validateURL(urlString) {
    try {
      new URL(urlString);
      return true;
    } catch (e) {
      return false;
    }
  }
}

module.exports = TtsTask;
