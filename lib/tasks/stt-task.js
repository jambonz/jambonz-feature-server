const Task = require('./task');
const assert = require('assert');
const { TaskPreconditions } = require('../utils/constants');

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
      compileSonioxTranscripts
    } = require('../utils/transcription-utils')(logger);
    this.setChannelVarsForStt = setChannelVarsForStt;
    this.normalizeTranscription = normalizeTranscription;
    this.removeSpeechListeners = removeSpeechListeners;
    this.compileSonioxTranscripts = compileSonioxTranscripts;

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
    } else {
      this.data.recognizer = {hints: [], altLanguages: []};
    }

    /* buffer for soniox transcripts */
    this._sonioxTranscripts = [];

  }

  async _initSpeechCredentials(cs, vendor, label) {
    const {getNuanceAccessToken, getIbmAccessToken} = this.cs.srf.locals.dbHelpers;
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
}

module.exports = SttTask;
