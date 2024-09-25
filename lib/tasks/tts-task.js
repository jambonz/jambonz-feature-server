const Task = require('./task');
const { TaskPreconditions } = require('../utils/constants');

class TtsTask extends Task {

  constructor(logger, data, parentTask) {
    super(logger, data);
    this.parentTask = parentTask;

    this.preconditions = TaskPreconditions.Endpoint;

    this.earlyMedia = this.data.earlyMedia === true || (parentTask && parentTask.earlyMedia);
    /**
     * Task use taskInlcudeSynthesizer to identify
     * if taskInlcudeSynthesizer === true, use label from verb.synthesizer, even it's empty
     * if taskInlcudeSynthesizer === false, use label from application.synthesizer
     */
    this.taskInlcudeSynthesizer = !!this.data.synthesizer;
    this.synthesizer = this.data.synthesizer || {};
    this.disableTtsCache = this.data.disableTtsCache;
    this.options = this.synthesizer.options || {};
  }

  async exec(cs) {
    super.exec(cs);
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
  }

  async _synthesizeWithSpecificVendor(cs, ep, {vendor, language, voice, label, preCache = false}) {
    const {srf, accountSid:account_sid} = cs;
    const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, srf);
    const {writeAlerts, AlertType, stats} = srf.locals;
    const {synthAudio} = srf.locals.dbHelpers;
    const engine = this.synthesizer.engine || cs.synthesizer?.engine || 'neural';
    const salt = cs.callSid;

    let credentials = cs.getSpeechCredentials(vendor, 'tts', label);
    if (!credentials) {
      throw new Error(`No text-to-speech service credentials for ${vendor} with labels: ${label} have been configured`);
    }
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
    } else if (vendor === 'rimelabs') {
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
    }

    ep.set({
      tts_engine: vendor.startsWith('custom:') ? 'custom' : vendor,
      tts_voice: voice,
      cache_speech_handles: !cs.currentTtsVendor || cs.currentTtsVendor === vendor ? 1 : 0,
    }).catch((err) => this.logger.info({err}, 'Error setting tts_engine on endpoint'));
    // set the current vendor on the call session
    // If vendor is changed from the previous one, then reset the cache_speech_handles flag
    cs.currentTtsVendor = vendor;

    if (!preCache && !this._disableTracing) this.logger.info({vendor, language, voice, model}, 'TaskSay:exec');
    try {
      if (!credentials) {
        writeAlerts({
          account_sid,
          alert_type: AlertType.TTS_NOT_PROVISIONED,
          vendor,
          target_sid: cs.callSid
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
            vendor,
            language,
            voice,
            engine,
            model,
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
            if (!servedFromCache && !lastUpdated) {
              lastUpdated = true;
              updateSpeechCredentialLastUsed(credentials.speech_credential_sid).catch(() => {/* logged error */});
            }
            if (!servedFromCache && rtt && !preCache  && !this._disableTracing) {
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
            this.logger.debug('Say: a streaming tts api will be used');
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
            detail: err.message,
            target_sid: cs.callSid
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
