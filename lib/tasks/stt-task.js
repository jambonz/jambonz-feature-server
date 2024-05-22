const Task = require('./task');
const assert = require('assert');
const crypto = require('crypto');
const { TaskPreconditions, CobaltTranscriptionEvents } = require('../utils/constants');

class SttTask extends Task {

  constructor(logger, data, parentTask) {
    super(logger, data);
    this.parentTask = parentTask;

    this.preconditions = TaskPreconditions.Endpoint;

    const {
      setChannelVarsForStt,
      normalizeTranscription,
      setSpeechCredentialsAtRuntime,
      compileSonioxTranscripts,
      consolidateTranscripts
    } = require('../utils/transcription-utils')(logger);
    this.setChannelVarsForStt = setChannelVarsForStt;
    this.normalizeTranscription = normalizeTranscription;
    this.compileSonioxTranscripts = compileSonioxTranscripts;
    this.consolidateTranscripts = consolidateTranscripts;
    this.eventHandlers = [];
    this.isHandledByPrimaryProvider = true;
    if (this.data.recognizer) {
      const recognizer = this.data.recognizer;
      this.vendor = recognizer.vendor;
      this.language = recognizer.language;
      this.label = recognizer.label;

      //fallback
      this.fallbackVendor = recognizer.fallbackVendor || 'default';
      this.fallbackLanguage = recognizer.fallbackLanguage || 'default';
      this.fallbackLabel = recognizer.fallbackLabel || 'default';

      /* let credentials be supplied in the recognizer object at runtime */
      this.sttCredentials = setSpeechCredentialsAtRuntime(recognizer);

      if (!Array.isArray(this.data.recognizer.altLanguages)) {
        this.data.recognizer.altLanguages = [];
      }
    } else {
      this.data.recognizer = {hints: [], altLanguages: []};
    }

    /* buffer for soniox transcripts */
    this._sonioxTranscripts = [];
    /*bug name prefix */
    this.bugname_prefix = '';

  }

  async exec(cs, {ep, ep2}) {
    super.exec(cs);
    this.ep = ep;
    this.ep2 = ep2;

    // use session preferences if we don't have specific verb-level settings.
    if (cs.recognizer) {
      for (const k in cs.recognizer) {
        const newValue = this.data.recognizer && this.data.recognizer[k] !== undefined ?
          this.data.recognizer[k] :
          cs.recognizer[k];

        if (Array.isArray(newValue)) {
          this.data.recognizer[k] = [...(this.data.recognizer[k] || []), ...cs.recognizer[k]];
        } else if (typeof newValue === 'object' && newValue !== null) {
          this.data.recognizer[k] = { ...(this.data.recognizer[k] || {}), ...cs.recognizer[k] };
        } else {
          this.data.recognizer[k] = newValue;
        }
      }
    }
    if ('default' === this.vendor || !this.vendor) {
      this.vendor = cs.speechRecognizerVendor;
      if (this.data.recognizer) this.data.recognizer.vendor = this.vendor;
    }
    if ('default' === this.language || !this.language) {
      this.language = cs.speechRecognizerLanguage;
      if (this.data.recognizer) this.data.recognizer.language = this.language;
    }
    if ('default' === this.label || !this.label) {
      this.label = cs.speechRecognizerLabel;
      if (this.data.recognizer) this.data.recognizer.label = this.label;
    }
    // Fallback options
    if ('default' === this.fallbackVendor || !this.fallbackVendor) {
      this.fallbackVendor = cs.fallbackSpeechRecognizerVendor;
      if (this.data.recognizer) this.data.recognizer.fallbackVendor = this.fallbackVendor;
    }
    if ('default' === this.fallbackLanguage || !this.fallbackLanguage) {
      this.fallbackLanguage = cs.fallbackSpeechRecognizerLanguage;
      if (this.data.recognizer) this.data.recognizer.fallbackLanguage = this.fallbackLanguage;
    }
    if ('default' === this.fallbackLabel || !this.fallbackLabel) {
      this.fallbackLabel = cs.fallbackSpeechRecognizerLabel;
      if (this.data.recognizer) this.data.recognizer.fallbackLabel = this.fallbackLabel;
    }
    // If call is already fallback to 2nd ASR vendor
    // use that.
    if (cs.hasFallbackAsr) {
      this.vendor = this.fallbackVendor;
      this.language = this.fallbackLanguage;
      this.label = this.fallbackLabel;
    }
    if (!this.data.recognizer.vendor) {
      this.data.recognizer.vendor = this.vendor;
    }
    if (this.vendor === 'cobalt' && !this.data.recognizer.model) {
      // By default, application saves cobalt model in language
      this.data.recognizer.model = cs.speechRecognizerLanguage;
    }

    if (
      // not gather task, such as transcribe
      (!this.input ||
      // gather task with speech
        this.input.includes('speech')) &&
      !this.sttCredentials) {
      try {
        this.sttCredentials = await this._initSpeechCredentials(this.cs, this.vendor, this.label);
      } catch (error) {
        if (this.canFallback) {
          this.notifyError(
            {
              msg: 'ASR error', details:`Invalid vendor ${this.vendor}, Error: ${error}`,
              failover: 'in progress'
            });
          await this._initFallback();
        } else {
          this.notifyError(
            {
              msg: 'ASR error', details:`Invalid vendor ${this.vendor}, Error: ${error}`,
              failover: 'not available'
            });
          throw error;
        }
      }
    }

    /* when using cobalt model is required */
    if (this.vendor === 'cobalt' && !this.data.recognizer.model) {
      this.notifyError({ msg: 'ASR error', details:'Cobalt requires a model to be specified'});
      throw new Error('Cobalt requires a model to be specified');
    }

    if (cs.hasAltLanguages) {
      this.data.recognizer.altLanguages = this.data.recognizer.altLanguages.concat(cs.altLanguages);
      this.logger.debug({altLanguages: this.altLanguages},
        'STT:exec - applying altLanguages');
    }
    if (cs.hasGlobalSttPunctuation && !this.data.recognizer.punctuation) {
      this.data.recognizer.punctuation = cs.globalSttPunctuation;
    }
  }

  addCustomEventListener(ep, event, handler) {
    this.eventHandlers.push({ep, event, handler});
    ep.addCustomEventListener(event, handler);
  }

  removeCustomEventListeners() {
    this.eventHandlers.forEach((h) => h.ep.removeCustomEventListener(h.event, h.handler));
  }

  async _initSpeechCredentials(cs, vendor, label) {
    const {getNuanceAccessToken, getIbmAccessToken, getAwsAuthToken, getVerbioAccessToken} = cs.srf.locals.dbHelpers;
    let credentials = cs.getSpeechCredentials(vendor, 'stt', label);

    if (!credentials) {
      const {writeAlerts, AlertType} = cs.srf.locals;
      this.logger.info(`ERROR stt using ${vendor} requested but creds not supplied`);
      writeAlerts({
        account_sid: cs.accountSid,
        alert_type: AlertType.STT_NOT_PROVISIONED,
        vendor
      }).catch((err) => this.logger.info({err}, 'Error generating alert for no stt'));
      this.notifyTaskDone();
      throw new Error(`No speech-to-text service credentials for ${vendor} have been configured`);
    }

    if (vendor === 'nuance' && credentials.client_id) {
      /* get nuance access token */
      const {client_id, secret} = credentials;
      const {access_token, servedFromCache} = await getNuanceAccessToken(client_id, secret, 'asr tts');
      this.logger.debug({client_id}, `got nuance access token ${servedFromCache ? 'from cache' : ''}`);
      credentials = {...credentials, access_token};
    }
    else if (vendor == 'ibm' && credentials.stt_api_key) {
      /* get ibm access token */
      const {stt_api_key, stt_region} = credentials;
      const {access_token, servedFromCache} = await getIbmAccessToken(stt_api_key);
      this.logger.debug({stt_api_key}, `got ibm access token ${servedFromCache ? 'from cache' : ''}`);
      credentials = {...credentials, access_token, stt_region};
    } else if (['aws', 'polly'].includes(vendor) && credentials.roleArn) {
      /* get aws access token */
      const {roleArn} = credentials;
      const {accessKeyId, secretAccessKey, sessionToken, servedFromCache} = await getAwsAuthToken(roleArn);
      this.logger.debug({roleArn}, `got aws access token ${servedFromCache ? 'from cache' : ''}`);
      credentials = {...credentials, accessKeyId, secretAccessKey, sessionToken};
    } else if (vendor === 'verbio' && credentials.client_id && credentials.client_secret) {
      const {access_token, servedFromCache} = await getVerbioAccessToken(credentials);
      this.logger.debug({client_id: credentials.client_id},
        `got verbio access token ${servedFromCache ? 'from cache' : ''}`);
      credentials.access_token = access_token;
    }
    return credentials;
  }

  get canFallback() {
    return this.fallbackVendor && this.isHandledByPrimaryProvider && !this.cs.hasFallbackAsr;
  }

  async _initFallback() {
    assert(this.fallbackVendor, 'fallback failed without fallbackVendor configuration');
    this.isHandledByPrimaryProvider = false;
    this.cs.hasFallbackAsr = true;
    this.logger.info(`Failed to use primary STT provider, fallback to ${this.fallbackVendor}`);
    this.vendor = this.fallbackVendor;
    this.language = this.fallbackLanguage;
    this.label = this.fallbackLabel;
    this.data.recognizer.vendor = this.vendor;
    this.data.recognizer.language = this.language;
    this.data.recognizer.label = this.label;
    this.sttCredentials = await this._initSpeechCredentials(this.cs, this.vendor, this.label);
    // cleanup previous listener from previous vendor
    this.removeCustomEventListeners();
  }

  async compileHintsForCobalt(ep, hostport, model, token, hints) {
    const {retrieveKey} = this.cs.srf.locals.dbHelpers;
    const hash = crypto.createHash('sha1');
    hash.update(`${model}:${hints}`);
    const key = `cobalt:${hash.digest('hex')}`;
    this.context = await retrieveKey(key);
    if (this.context) {
      this.logger.debug({model, hints}, 'found cached cobalt context for supplied hints');
      return this.context;
    }

    this.logger.debug({model, hints}, 'compiling cobalt context for supplied hints');

    return new Promise((resolve, reject) => {
      this.cobaltCompileResolver = resolve;
      ep.addCustomEventListener(CobaltTranscriptionEvents.CompileContext, this._onCompileContext.bind(this, ep, key));
      ep.api('uuid_cobalt_compile_context', [ep.uuid, hostport, model, token, hints], (err, evt) => {
        if (err || 0 !== evt.getBody().indexOf('+OK')) {
          ep.removeCustomEventListener(CobaltTranscriptionEvents.CompileContext);
          return reject(err);
        }
      });
    });
  }

  _onCompileContext(ep, key, evt) {
    const {addKey} = this.cs.srf.locals.dbHelpers;
    this.logger.debug({evt}, `received cobalt compile context event, will cache under ${key}`);

    this.cobaltCompileResolver(evt.compiled_context);
    ep.removeCustomEventListener(CobaltTranscriptionEvents.CompileContext);
    this.cobaltCompileResolver = null;

    //cache the compiled context
    addKey(key, evt.compiled_context, 3600 * 12)
      .catch((err) => this.logger.info({err}, `Error caching cobalt context for ${key}`));
  }

  _doContinuousAsrWithDeepgram(asrTimeout) {
    /* deepgram has an utterance_end_ms property that simplifies things */
    assert(this.vendor === 'deepgram');
    if (asrTimeout < 1000) {
      this.notifyError({
        msg: 'ASR error',
        details:`asrTimeout ${asrTimeout} is too short for deepgram; setting it to 1000ms`
      });
      asrTimeout = 1000;
    }
    else if (asrTimeout > 5000) {
      this.notifyError({
        msg: 'ASR error',
        details:`asrTimeout ${asrTimeout} is too long for deepgram; setting it to 5000ms`
      });
      asrTimeout = 5000;
    }
    this.logger.debug(`_doContinuousAsrWithDeepgram - setting utterance_end_ms to ${asrTimeout}`);
    const dgOptions = this.data.recognizer.deepgramOptions = this.data.recognizer.deepgramOptions || {};
    dgOptions.utteranceEndMs = dgOptions.utteranceEndMs || asrTimeout;
  }

  _onVendorConnect(_cs, _ep) {
    this.logger.debug(`TaskGather:_on${this.vendor}Connect`);
  }

  _onVendorError(cs, _ep, evt) {
    this.logger.info({evt}, `${this.name}:_on${this.vendor}Error`);
    const {writeAlerts, AlertType} = cs.srf.locals;
    writeAlerts({
      account_sid: cs.accountSid,
      alert_type: AlertType.STT_FAILURE,
      message: 'STT failure reported by vendor',
      detail: evt.error,
      vendor: this.vendor,
    }).catch((err) => this.logger.info({err}, `Error generating alert for ${this.vendor} connection failure`));
  }

  _onVendorConnectFailure(cs, _ep, evt) {
    const {reason} = evt;
    const {writeAlerts, AlertType} = cs.srf.locals;
    this.logger.info({evt}, `${this.name}:_on${this.vendor}ConnectFailure`);
    writeAlerts({
      account_sid: cs.accountSid,
      alert_type: AlertType.STT_FAILURE,
      message: `Failed connecting to ${this.vendor} speech recognizer: ${reason}`,
      vendor: this.vendor,
    }).catch((err) => this.logger.info({err}, `Error generating alert for ${this.vendor} connection failure`));
  }
}

module.exports = SttTask;
