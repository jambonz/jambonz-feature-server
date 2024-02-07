const Task = require('./task');
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

class TaskSay extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.text = (Array.isArray(this.data.text) ? this.data.text : [this.data.text])
      .map((t) => breakLengthyTextIfNeeded(this.logger, t))
      .flat();

    this.loop = this.data.loop || 1;
    this.earlyMedia = this.data.earlyMedia === true || (parentTask && parentTask.earlyMedia);
    this.synthesizer = this.data.synthesizer || {};
    this.disableTtsCache = this.data.disableTtsCache;
    this.options = this.synthesizer.options || {};
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
    const {srf} = cs;
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

    if (!preCache) this.logger.info({vendor, language, voice, model}, 'TaskSay:exec');
    try {
      if (!credentials) {
        writeAlerts({
          account_sid: cs.accountSid,
          alert_type: AlertType.TTS_NOT_PROVISIONED,
          vendor
        }).catch((err) => this.logger.info({err}, 'Error generating alert for no tts'));
        this.notifyError({
          msg: 'TTS error',
          details:`No speech credentials provisioned for selected vendor ${vendor}`
        });
        throw new Error('no provisioned speech credentials for TTS');
      }
      // synthesize all of the text elements
      let lastUpdated = false;

      /* produce an audio segment from the provided text */
      const generateAudio = async(text) => {
        if (this.killed) return;
        if (text.startsWith('silence_stream://')) return text;

        /* otel: trace time for tts */
        let otelSpan;
        if (!preCache)  {
          const {span} = this.startChildSpan('tts-generation', {
            'tts.vendor': vendor,
            'tts.language': language,
            'tts.voice': voice
          });
          otelSpan = span;
        }
        try {
          const {filePath, servedFromCache, rtt} = await synthAudio(stats, {
            account_sid: cs.accountSid,
            text,
            vendor,
            language,
            voice,
            engine,
            model,
            salt,
            credentials,
            options: this.options,
            disableTtsCache : this.disableTtsCache
          });
          this.logger.debug(`file ${filePath}, served from cache ${servedFromCache}`);
          if (filePath) cs.trackTmpFile(filePath);
          if (!servedFromCache && !lastUpdated) {
            lastUpdated = true;
            updateSpeechCredentialLastUsed(credentials.speech_credential_sid)
              .catch(() => {/*already logged error */});
          }
          if (otelSpan) otelSpan.setAttributes({'tts.cached': servedFromCache});
          if (otelSpan) otelSpan.end();
          if (!servedFromCache && rtt && !preCache) {
            this.notifyStatus({
              event: 'synthesized-audio',
              vendor,
              language,
              characters: text.length,
              elapsedTime: rtt
            });
          }
          return filePath;
        } catch (err) {
          this.logger.info({err}, 'Error synthesizing tts');
          if (otelSpan) otelSpan.end();
          writeAlerts({
            account_sid: cs.accountSid,
            alert_type: AlertType.TTS_FAILURE,
            vendor,
            detail: err.message
          }).catch((err) => this.logger.info({err}, 'Error generating alert for tts failure'));
          this.notifyError({msg: 'TTS error', details: err.message || err});
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
    await super.exec(cs);
    this.ep = ep;

    const vendor = this.synthesizer.vendor && this.synthesizer.vendor !== 'default' ?
      this.synthesizer.vendor :
      cs.speechSynthesisVendor;
    const language = this.synthesizer.language && this.synthesizer.language !== 'default' ?
      this.synthesizer.language :
      cs.speechSynthesisLanguage ;
    const voice =  this.synthesizer.voice && this.synthesizer.voice !== 'default' ?
      this.synthesizer.voice :
      cs.speechSynthesisVoice;
    const label = this.synthesizer.label && this.synthesizer.label !== 'default' ?
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

    let filepath;
    try {
      filepath = await this._synthesizeWithSpecificVendor(cs, ep, {vendor, language, voice, label});
    } catch (error) {
      if (fallbackVendor && this.isHandledByPrimaryProvider) {
        this.isHandledByPrimaryProvider = false;
        this.logger.info(`Synthesize error, fallback to ${fallbackVendor}`);
        filepath = await this._synthesizeWithSpecificVendor(cs, ep,
          {
            vendor: fallbackVendor,
            language: fallbackLanguage,
            voice: fallbackVoice,
            label: fallbackLabel
          });
      } else {
        throw error;
      }
    }
    this.notifyStatus({event: 'start-playback'});

    while (!this.killed && (this.loop === 'forever' || this.loop--) && this.ep?.connected) {
      let segment = 0;
      while (!this.killed && segment < filepath.length) {
        if (cs.isInConference) {
          const {memberId, confName, confUuid} = cs;
          await this.playToConfMember(this.ep, memberId, confName, confUuid, filepath[segment]);
        }
        else {
          this.logger.debug(`Say:exec sending command to play file ${filepath[segment]}`);
          const {span} = this.startChildSpan('start-audio');
          this.ep.once('playback-start', ({file}) => span?.end());
          await ep.play(filepath[segment]);
          this.logger.debug(`Say:exec completed play file ${filepath[segment]}`);
        }
        segment++;
      }
    }
    this.emit('playDone');
  }

  async kill(cs) {
    super.kill(cs);
    if (this.ep.connected) {
      this.logger.debug('TaskSay:kill - killing audio');
      if (cs.isInConference) {
        const {memberId, confName} = cs;
        this.killPlayToConfMember(this.ep, memberId, confName);
      }
      else {
        this.notifyStatus({event: 'kill-playback'});
        this.ep.api('uuid_break', this.ep.uuid);
      }
      this.ep.removeEventListeners('playback-start');
    }
  }
}

module.exports = TaskSay;
