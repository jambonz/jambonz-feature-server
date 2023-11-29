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
      removeSpeechListeners,
      setSpeechCredentialsAtRuntime,
      compileSonioxTranscripts,
      consolidateTranscripts
    } = require('../utils/transcription-utils')(logger);
    this.setChannelVarsForStt = setChannelVarsForStt;
    this.normalizeTranscription = normalizeTranscription;
    this.removeSpeechListeners = removeSpeechListeners;
    this.compileSonioxTranscripts = compileSonioxTranscripts;
    this.consolidateTranscripts = consolidateTranscripts;

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

  }

  async _initSpeechCredentials(cs, vendor, label) {
    const {getNuanceAccessToken, getIbmAccessToken, getAwsAuthToken} = this.cs.srf.locals.dbHelpers;
    let credentials = cs.getSpeechCredentials(vendor, 'stt', label);

    if (!credentials) {
      const {writeAlerts, AlertType} = cs.srf.locals;
      this.logger.info(`ERROR stt using ${vendor} requested but creds not supplied`);
      writeAlerts({
        account_sid: cs.accountSid,
        alert_type: AlertType.STT_NOT_PROVISIONED,
        vendor
      }).catch((err) => this.logger.info({err}, 'Error generating alert for no stt'));
      // Notify application that STT vender is wrong.
      this.notifyError({
        msg: 'ASR error',
        details: `No speech-to-text service credentials for ${vendor} have been configured`
      });
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
    }
    else if (vendor == 'aws') {
      /* get AWS access token */
      const {accessKeyId, secretAccessKey, region } = credentials;
      const { servedFromCache, ...newCredentials} = await getAwsAuthToken(accessKeyId, secretAccessKey, region);
      this.logger.debug({newCredentials}, `got aws security token ${servedFromCache ? 'from cache' : ''}`);
      credentials = {...newCredentials, region};
    }
    return credentials;
  }

  async _fallback() {
    assert(this.fallbackVendor, 'fallback failed without fallbackVendor configuration');
    this.isHandledByPrimaryProvider = false;
    this.logger.info(`Failed to use primary STT provider, fallback to ${this.fallbackVendor}`);
    this.vendor = this.fallbackVendor;
    this.language = this.fallbackLanguage;
    this.label = this.fallbackLabel;
    this.data.recognizer.vendor = this.vendor;
    this.data.recognizer.language = this.language;
    this.data.recognizer.label = this.label;
    this.sttCredentials = await this._initSpeechCredentials(this.cs, this.vendor, this.label);
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
    this.notifyError({msg: 'ASR error', details:`Failed connecting to speech vendor ${this.vendor}: ${evt.error}`});
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
    this.notifyError({msg: 'ASR error', details:`Failed connecting to speech vendor ${this.vendor}: ${reason}`});
  }
}

module.exports = SttTask;
