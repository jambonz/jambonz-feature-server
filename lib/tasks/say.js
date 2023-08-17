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
  }

  get name() { return TaskName.Say; }

  get summary() {
    for (let i = 0; i < this.text.length; i++) {
      if (this.text[i].startsWith('silence_stream')) continue;
      return `${this.name}{text=${this.text[i].slice(0, 15)}${this.text[i].length > 15 ? '...' : ''}}`;
    }
    return `${this.name}{${this.text[0]}}`;
  }

  async exec(cs, {ep}) {
    await super.exec(cs);

    const {srf} = cs;
    const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, srf);
    const {writeAlerts, AlertType, stats} = srf.locals;
    const {synthAudio} = srf.locals.dbHelpers;
    const vendor = this.synthesizer.vendor && this.synthesizer.vendor !== 'default' ?
      this.synthesizer.vendor :
      cs.speechSynthesisVendor;
    const fallbackVendor = this.synthesizer.fallbackVendor && this.synthesizer.fallbackVendor !== 'default' ?
      this.synthesizer.fallbackVendor :
      cs.fallbackSpeechSynthesisVendor;
    const language = this.synthesizer.language && this.synthesizer.language !== 'default' ?
      this.synthesizer.language :
      cs.speechSynthesisLanguage ;
    const fallbackLanguage = this.synthesizer.fallbackLanguage && this.synthesizer.fallbackLanguage !== 'default' ?
      this.synthesizer.fallbackLanguage :
      cs.fallbackSpeechSynthesisLanguage ;
    let voice =  this.synthesizer.voice && this.synthesizer.voice !== 'default' ?
      this.synthesizer.voice :
      cs.speechSynthesisVoice;
    const fallbackVoice = this.synthesizer.fallbackVoice && this.synthesizer.fallbackVoice !== 'default' ?
      this.synthesizer.fallbackVoice :
      cs.fallbackSpeechSynthesisVoice;
    const fallbackLabel = this.synthesizer.fallbackLabel && this.synthesizer.fallbackLabel !== 'default' ?
      this.synthesizer.fallbackLabel :
      cs.fallbackSpeechSynthesisLabel;
    const engine = this.synthesizer.engine || 'standard';
    const salt = cs.callSid;
    let credentials = cs.getSpeechCredentials(vendor, 'tts', this.data.synthesizer ?
      this.data.synthesizer?.label : cs.speechSynthesisLabel);

    /* parse Nuance voices into name and model */
    let model;
    if (vendor === 'nuance' && voice) {
      const arr = /([A-Za-z-]*)\s+-\s+(enhanced|standard)/.exec(voice);
      if (arr) {
        voice = arr[1];
        model = arr[2];
      }
    }

    /* allow for microsoft custom region voice and api_key to be specified as an override */
    if (vendor === 'microsoft' && this.options.deploymentId) {
      credentials = credentials || {};
      credentials.use_custom_tts = true;
      credentials.custom_tts_endpoint = this.options.deploymentId;
      credentials.api_key = this.options.apiKey || credentials.apiKey;
      credentials.region = this.options.region || credentials.region;
      voice = this.options.voice || voice;
    }

    this.logger.info({vendor, language, voice, model}, 'TaskSay:exec');
    this.ep = ep;
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
        const {span} = this.startChildSpan('tts-generation', {
          'tts.vendor': vendor,
          'tts.language': language,
          'tts.voice': voice
        });
        let filePathUrl, isFromCache, roundTripTime;
        let executedVendor, executedLanguage;
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
            disableTtsCache : this.disableTtsCache
          });

          span.setAttributes({'tts.cached': servedFromCache});
          span.end();

          if (!servedFromCache && !lastUpdated) {
            lastUpdated = true;
            updateSpeechCredentialLastUsed(credentials.speech_credential_sid)
              .catch(() => {/*already logged error */});
          }

          filePathUrl = filePath;
          isFromCache = servedFromCache;
          roundTripTime = rtt;
          executedVendor = vendor;
          executedLanguage = language;

        } catch (error) {
          if (fallbackVendor) {
            const fallbackcredentials = cs.getSpeechCredentials(fallbackVendor, 'tts', fallbackLabel);
            const {span: fallbackSpan} = this.startChildSpan('fallback-tts-generation', {
              'tts.vendor': fallbackVendor,
              'tts.language': fallbackLanguage,
              'tts.voice': fallbackVoice
            });

            try {
              const {filePath, servedFromCache, rtt} = await synthAudio(stats, {
                account_sid: cs.accountSid,
                text,
                fallbackVendor,
                fallbackLanguage,
                fallbackVoice,
                engine,
                model,
                salt,
                credentials: fallbackcredentials,
                disableTtsCache : this.disableTtsCache
              });

              fallbackSpan.setAttributes({'tts.cached': servedFromCache});
              fallbackSpan.end();

              if (!servedFromCache && !lastUpdated) {
                lastUpdated = true;
                updateSpeechCredentialLastUsed(credentials.speech_credential_sid)
                  .catch(() => {/*already logged error */});
              }

              filePathUrl = filePath;
              isFromCache = servedFromCache;
              roundTripTime = rtt;
              executedVendor = fallbackVendor;
              executedLanguage = fallbackLanguage;

            } catch (err) {
              this.logger.info({err}, 'fallback Speech failed to synthesize audio');
              fallbackSpan.end();
              writeAlerts({
                account_sid: cs.accountSid,
                alert_type: AlertType.TTS_FAILURE,
                vendor: fallbackVendor,
                detail: err.message
              }).catch((err) => this.logger.info({err}, 'Error generating alert for fallback tts failure'));
            }
          }

          this.logger.info({error}, 'Error synthesizing tts');
          span.end();
          writeAlerts({
            account_sid: cs.accountSid,
            alert_type: AlertType.TTS_FAILURE,
            vendor,
            detail: error.message
          }).catch((err) => this.logger.info({err}, 'Error generating alert for tts failure'));
          this.notifyError({msg: 'TTS error', details: error.message || error});
          return;
        }

        this.logger.debug(`file ${filePathUrl}, served from cache ${isFromCache}`);
        if (filePathUrl) cs.trackTmpFile(filePathUrl);

        if (!isFromCache && roundTripTime) {
          this.notifyStatus({
            event: 'synthesized-audio',
            vendor: executedVendor,
            language: executedLanguage,
            characters: text.length,
            elapsedTime: roundTripTime
          });
        }

        return filePathUrl;
      };

      const arr = this.text.map((t) => generateAudio(t));
      const filepath = (await Promise.all(arr)).filter((fp) => fp && fp.length);
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
            await ep.play(filepath[segment]);
            this.logger.debug(`Say:exec completed play file ${filepath[segment]}`);
          }
          segment++;
        }
      }
    } catch (err) {
      this.logger.info(err, 'TaskSay:exec error');
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
    }
  }
}

module.exports = TaskSay;
