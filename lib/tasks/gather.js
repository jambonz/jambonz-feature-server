const Task = require('./task');
const {
  TaskName,
  TaskPreconditions,
  GoogleTranscriptionEvents,
  AwsTranscriptionEvents,
  AzureTranscriptionEvents
} = require('../utils/constants');

const makeTask = require('./make_task');
const assert = require('assert');

const compileTranscripts = (logger, evt, arr) => {
  //logger.debug({arr, evt}, 'compile transcripts');
  if (!Array.isArray(arr) || arr.length === 0) return;
  let t = '';
  for (const a of arr) {
    //logger.debug(`adding ${a.alternatives[0].transcript}`);
    t += ` ${a.alternatives[0].transcript}`;
  }
  t += ` ${evt.alternatives[0].transcript}`;
  evt.alternatives[0].transcript = t.trim();
  //logger.debug(`compiled transcript: ${evt.alternatives[0].transcript}`);
};

class TaskGather extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    [
      'finishOnKey', 'hints', 'input', 'numDigits', 'minDigits', 'maxDigits',
      'interDigitTimeout', 'partialResultHook', 'bargein', 'dtmfBargein',
      'speechTimeout', 'timeout', 'say', 'play'
    ].forEach((k) => this[k] = this.data[k]);

    /* when collecting dtmf, bargein on dtmf is true unless explicitly set to false */
    if (this.dtmfBargein !== false  && this.input.includes('digits')) this.dtmfBargein = true;

    /* timeout of zero means no timeout */
    this.timeout = this.timeout === 0 ? 0 : (this.timeout || 15) * 1000;
    this.interim = !!this.partialResultHook || this.bargein;
    this.listenDuringPrompt = this.data.listenDuringPrompt === false ? false : true;
    this.minBargeinWordCount = this.data.minBargeinWordCount || 0;
    if (this.data.recognizer) {
      const recognizer = this.data.recognizer;
      this.vendor = recognizer.vendor;
      this.language = recognizer.language;
      this.hints = recognizer.hints || [];
      this.hintsBoost = recognizer.hintsBoost;
      this.profanityFilter = recognizer.profanityFilter;
      this.punctuation = !!recognizer.punctuation;
      this.enhancedModel = !!recognizer.enhancedModel;
      this.model = recognizer.model || 'command_and_search';
      this.words = !!recognizer.words;
      this.singleUtterance = recognizer.singleUtterance || true;
      this.diarization = !!recognizer.diarization;
      this.diarizationMinSpeakers = recognizer.diarizationMinSpeakers || 0;
      this.diarizationMaxSpeakers = recognizer.diarizationMaxSpeakers || 0;
      this.interactionType = recognizer.interactionType || 'unspecified';
      this.naicsCode = recognizer.naicsCode || 0;
      this.altLanguages = recognizer.altLanguages || [];

      /* continuous ASR (i.e. compile transcripts until a special timeout or dtmf key) */
      this.asrTimeout = typeof recognizer.asrTimeout === 'number' ? recognizer.asrTimeout * 1000 : 0;
      if (this.asrTimeout > 0) this.asrDtmfTerminationDigit = recognizer.asrDtmfTerminationDigit;
      this.isContinuousAsr = this.asrTimeout > 0;

      /* vad: if provided, we dont connect to recognizer until voice activity is detected */
      const {enable, voiceMs = 0, mode = -1} = recognizer.vad || {};
      this.vad = {enable, voiceMs, mode};

      /* aws options */
      this.vocabularyName = recognizer.vocabularyName;
      this.vocabularyFilterName = recognizer.vocabularyFilterName;
      this.filterMethod = recognizer.filterMethod;

      /* microsoft options */
      this.outputFormat = recognizer.outputFormat || 'simple';
      this.profanityOption = recognizer.profanityOption || 'raw';
      this.requestSnr = recognizer.requestSnr || false;
      this.initialSpeechTimeoutMs = recognizer.initialSpeechTimeoutMs || 0;
      this.azureServiceEndpoint = recognizer.azureServiceEndpoint;
      this.azureSttEndpointId = recognizer.azureSttEndpointId;

      /* nuance options */
      this.nuanceOptions = recognizer.nuanceOptions || {};
      const {clientId, secret} = this.nuanceOptions;
      if (clientId && secret) {
        this.sttCredentials = {clientId, secret};
      }
    }
    else {
      this.hints = [];
      this.altLanguages = [];
    }

    this.digitBuffer = '';
    this._earlyMedia = this.data.earlyMedia === true;

    if (this.say) {
      this.sayTask = makeTask(this.logger, {say: this.say}, this);
    }
    if (this.play) {
      this.playTask = makeTask(this.logger, {play: this.play}, this);
    }
    if (!this.sayTask && !this.playTask) this.listenDuringPrompt = false;

    /* buffer speech for continuous asr */
    this._bufferedTranscripts = [];

    this.parentTask = parentTask;
  }

  get name() { return TaskName.Gather; }

  get needsStt() { return this.input.includes('speech'); }

  get earlyMedia() {
    return (this.sayTask && this.sayTask.earlyMedia) ||
      (this.playTask && this.playTask.earlyMedia);
  }

  get summary() {
    let s = `${this.name}{`;
    if (this.input.length === 2) s += 'inputs=[speech,digits],';
    else if (this.input.includes('digits')) s += 'inputs=digits';
    else s += 'inputs=speech,';

    if (this.input.includes('speech')) {
      s += `vendor=${this.vendor || 'default'},language=${this.language || 'default'}`;
    }
    if (this.sayTask) s += ',with nested say task';
    if (this.playTask) s += ',with nested play task';
    s += '}';
    return s;
  }

  async exec(cs, {ep}) {
    this.logger.debug('Gather:exec');
    await super.exec(cs);
    const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, cs.srf);
    const {getNuanceAccessToken} = cs.srf.locals.dbHelpers;

    if (cs.hasGlobalSttHints) {
      const {hints, hintsBoost} = cs.globalSttHints;
      this.hints = this.hints.concat(hints);
      if (!this.hintsBoost && hintsBoost) this.hintsBoost = hintsBoost;
      this.logger.debug({hints: this.hints, hintsBoost: this.hintsBoost},
        'Gather:exec - applying global sttHints');
    }
    if (cs.hasAltLanguages) {
      this.altLanguages = this.altLanguages.concat(cs.altLanguages);
      this.logger.debug({altLanguages: this.altLanguages},
        'Gather:exec - applying altLanguages');
    }
    if (cs.hasGlobalSttPunctuation) {
      this.punctuation = cs.globalSttPunctuation;
    }
    if (!this.isContinuousAsr && cs.isContinuousAsr) {
      this.isContinuousAsr = true;
      this.asrTimeout = cs.asrTimeout * 1000;
      this.asrDtmfTerminationDigit = cs.asrDtmfTerminationDigit;
      this.logger.debug({
        asrTimeout: this.asrTimeout,
        asrDtmfTerminationDigit: this.asrDtmfTerminationDigit
      }, 'Gather:exec - enabling continuous ASR since it is turned on for the session');
    }
    this.ep = ep;
    if ('default' === this.vendor || !this.vendor) this.vendor = cs.speechRecognizerVendor;
    if ('default' === this.language || !this.language) this.language = cs.speechRecognizerLanguage;

    if (!this.sttCredentials) this.sttCredentials = cs.getSpeechCredentials(this.vendor, 'stt');
    if (this.needsStt && !this.sttCredentials) {
      const {writeAlerts, AlertType} = cs.srf.locals;
      this.logger.info(`TaskGather:exec - ERROR stt using ${this.vendor} requested but creds not supplied`);
      writeAlerts({
        account_sid: cs.accountSid,
        alert_type: AlertType.STT_NOT_PROVISIONED,
        vendor: this.vendor
      }).catch((err) => this.logger.info({err}, 'Error generating alert for no stt'));

      throw new Error(`no speech-to-text service credentials for ${this.vendor} have been configured`);
    }

    if (this.vendor === 'nuance') {
      /* get nuance access token */
      const {clientId, secret} = this.sttCredentials;
      const {access_token, servedFromCache} = await getNuanceAccessToken(clientId, secret, 'asr tts');
      this.logger.debug({clientId}, `Gather:exec - got nuance access token ${servedFromCache ? 'from cache' : ''}`);
      this.sttCredentials = {...this.sttCredentials, access_token};
    }
    const startListening = (cs, ep) => {
      this._startTimer();
      if (this.isContinuousAsr && 0 === this.timeout) this._startAsrTimer();
      if (this.input.includes('speech') && !this.listenDuringPrompt) {
        this._initSpeech(cs, ep)
          .then(() => {
            this._startTranscribing(ep);
            return updateSpeechCredentialLastUsed(this.sttCredentials.speech_credential_sid);
          })
          .catch(() => {});
      }
    };

    try {
      if (this.sayTask) {
        const {span, ctx} = this.startChildSpan(`nested:${this.sayTask.summary}`);
        this.sayTask.span = span;
        this.sayTask.ctx = ctx;
        this.sayTask.exec(cs, {ep});  // kicked off, _not_ waiting for it to complete
        this.sayTask.on('playDone', (err) => {
          span.end();
          if (err) this.logger.error({err}, 'Gather:exec Error playing tts');
          this.logger.debug('Gather: nested say task completed');
          if (!this.killed) startListening(cs, ep);
        });
      }
      else if (this.playTask) {
        const {span, ctx} = this.startChildSpan(`nested:${this.playTask.summary}`);
        this.playTask.span = span;
        this.playTask.ctx = ctx;
        this.playTask.exec(cs, {ep});  // kicked off, _not_ waiting for it to complete
        this.playTask.on('playDone', (err) => {
          span.end();
          if (err) this.logger.error({err}, 'Gather:exec Error playing url');
          this.logger.debug('Gather: nested play task completed');
          if (!this.killed) startListening(cs, ep);
        });
      }
      else startListening(cs, ep);

      if (this.input.includes('speech') && this.listenDuringPrompt) {
        await this._initSpeech(cs, ep);
        this._startTranscribing(ep);
        updateSpeechCredentialLastUsed(this.sttCredentials.speech_credential_sid)
          .catch(() => {/*already logged error */});
      }

      if (this.input.includes('digits') || this.dtmfBargein || this.asrDtmfTerminationDigit) {
        ep.on('dtmf', this._onDtmf.bind(this, cs, ep));
      }

      await this.awaitTaskDone();
    } catch (err) {
      this.logger.error(err, 'TaskGather:exec error');
    }
    ep.removeCustomEventListener(GoogleTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(GoogleTranscriptionEvents.EndOfUtterance);
    ep.removeCustomEventListener(GoogleTranscriptionEvents.VadDetected);
    ep.removeCustomEventListener(AwsTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(AwsTranscriptionEvents.VadDetected);
    ep.removeCustomEventListener(AzureTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(AzureTranscriptionEvents.NoSpeechDetected);
    ep.removeCustomEventListener(AzureTranscriptionEvents.VadDetected);
  }

  kill(cs) {
    super.kill(cs);
    this._killAudio(cs);
    this.ep.removeAllListeners('dtmf');
    clearTimeout(this.interDigitTimer);
    this.playTask?.span.end();
    this.sayTask?.span.end();
    this._resolve('killed');
  }

  updateTimeout(timeout) {
    this.logger.info(`TaskGather:updateTimeout - updating timeout to ${timeout}`);
    this.timeout = timeout;
    this._startTimer();
  }

  _onDtmf(cs, ep, evt) {
    this.logger.debug(evt, 'TaskGather:_onDtmf');
    clearTimeout(this.interDigitTimer);
    let resolved = false;
    if (this.dtmfBargein) {
      this._killAudio(cs);
      this.emit('dtmf', evt);
    }
    if (evt.dtmf === this.finishOnKey && this.input.includes('digits')) {
      resolved = true;
      this._resolve('dtmf-terminator-key');
    }
    else if (this.input.includes('digits')) {
      this.digitBuffer += evt.dtmf;
      const len = this.digitBuffer.length;
      if (len === this.numDigits || len === this.maxDigits) {
        resolved = true;
        this._resolve('dtmf-num-digits');
      }
    }
    else if (this.isContinuousAsr && evt.dtmf === this.asrDtmfTerminationDigit) {
      this.logger.info(`continuousAsr triggered with dtmf ${this.asrDtmfTerminationDigit}`);
      this._clearAsrTimer();
      this._clearTimer();
      this._startFinalAsrTimer();
      return;
    }
    if (!resolved && this.interDigitTimeout > 0 && this.digitBuffer.length >= this.minDigits) {
      /* start interDigitTimer */
      const ms = this.interDigitTimeout * 1000;
      this.logger.debug(`starting interdigit timer of ${ms}`);
      this.interDigitTimer = setTimeout(() => this._resolve('dtmf-interdigit-timeout'), ms);
    }
  }

  async _initSpeech(cs, ep) {
    let opts = {};

    if (this.vad?.enable) {
      opts.START_RECOGNIZING_ON_VAD = 1;
      if (this.vad.voiceMs) opts.RECOGNIZER_VAD_VOICE_MS = this.vad.voiceMs;
      else opts.RECOGNIZER_VAD_VOICE_MS = 125;
      if (this.vad.mode >= 0 && this.vad.mode <= 3) opts.RECOGNIZER_VAD_MODE = this.vad.mode;
    }

    if ('google' === this.vendor) {
      this.bugname = 'google_transcribe';
      if (this.sttCredentials) opts.GOOGLE_APPLICATION_CREDENTIALS = JSON.stringify(this.sttCredentials.credentials);
      [
        ['enhancedModel', 'GOOGLE_SPEECH_USE_ENHANCED'],
        ['separateRecognitionPerChannel', 'GOOGLE_SPEECH_SEPARATE_RECOGNITION_PER_CHANNEL'],
        ['profanityFilter', 'GOOGLE_SPEECH_PROFANITY_FILTER'],
        ['punctuation', 'GOOGLE_SPEECH_ENABLE_AUTOMATIC_PUNCTUATION'],
        ['words', 'GOOGLE_SPEECH_ENABLE_WORD_TIME_OFFSETS'],
        ['singleUtterance', 'GOOGLE_SPEECH_SINGLE_UTTERANCE'],
        ['diarization', 'GOOGLE_SPEECH_PROFANITY_FILTER']
      ].forEach((arr) => {
        if (this[arr[0]]) opts[arr[1]] = true;
        else if (this[arr[0]] === false) opts[arr[1]] = false;
      });
      if (this.hints.length > 0) {
        opts.GOOGLE_SPEECH_HINTS = this.hints.join(',');
        if (typeof this.hintsBoost === 'number') {
          opts.GOOGLE_SPEECH_HINTS_BOOST = this.hintsBoost;
        }
      }
      if (this.altLanguages.length > 0) opts.GOOGLE_SPEECH_ALTERNATIVE_LANGUAGE_CODES = this.altLanguages.join(',');
      else opts.GOOGLE_SPEECH_ALTERNATIVE_LANGUAGE_CODES = '';
      if ('unspecified' !== this.interactionType) {
        opts.GOOGLE_SPEECH_METADATA_INTERACTION_TYPE = this.interactionType;
      }
      opts.GOOGLE_SPEECH_MODEL = this.model;
      if (this.diarization && this.diarizationMinSpeakers > 0) {
        opts.GOOGLE_SPEECH_SPEAKER_DIARIZATION_MIN_SPEAKER_COUNT = this.diarizationMinSpeakers;
      }
      if (this.diarization && this.diarizationMaxSpeakers > 0) {
        opts.GOOGLE_SPEECH_SPEAKER_DIARIZATION_MAX_SPEAKER_COUNT = this.diarizationMaxSpeakers;
      }
      if (this.naicsCode > 0) opts.GOOGLE_SPEECH_METADATA_INDUSTRY_NAICS_CODE = this.naicsCode;
      ep.addCustomEventListener(GoogleTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
      ep.addCustomEventListener(GoogleTranscriptionEvents.EndOfUtterance, this._onEndOfUtterance.bind(this, cs, ep));
      ep.addCustomEventListener(GoogleTranscriptionEvents.VadDetected, this._onVadDetected.bind(this, cs, ep));
    }
    else if (['aws', 'polly'].includes(this.vendor)) {
      this.bugname = 'aws_transcribe';
      if (this.vocabularyName) opts.AWS_VOCABULARY_NAME = this.vocabularyName;
      if (this.vocabularyFilterName) {
        opts.AWS_VOCABULARY_NAME = this.vocabularyFilterName;
        opts.AWS_VOCABULARY_FILTER_METHOD = this.filterMethod || 'mask';
      }
      if (this.sttCredentials) {
        Object.assign(opts, {
          AWS_ACCESS_KEY_ID: this.sttCredentials.accessKeyId,
          AWS_SECRET_ACCESS_KEY: this.sttCredentials.secretAccessKey,
          AWS_REGION: this.sttCredentials.region
        });
      }
      ep.addCustomEventListener(AwsTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
      ep.addCustomEventListener(AwsTranscriptionEvents.VadDetected, this._onVadDetected.bind(this, cs, ep));
    }
    else if ('microsoft' === this.vendor) {
      this.bugname = 'azure_transcribe';
      if (this.sttCredentials) {
        const {api_key, region, use_custom_stt, custom_stt_endpoint} = this.sttCredentials;

        Object.assign(opts, {
          'AZURE_SUBSCRIPTION_KEY': api_key,
          'AZURE_REGION': region
        });
        if (this.azureSttEndpointId) {
          Object.assign(opts, {'AZURE_SERVICE_ENDPOINT_ID': this.azureSttEndpointId});
        }
        else if (use_custom_stt && custom_stt_endpoint) {
          Object.assign(opts, {'AZURE_SERVICE_ENDPOINT_ID': custom_stt_endpoint});
        }
      }
      if (this.hints && this.hints.length > 0) {
        opts.AZURE_SPEECH_HINTS = this.hints.map((h) => h.trim()).join(',');
      }
      if (this.altLanguages && this.altLanguages.length > 0) {
        opts.AZURE_SPEECH_ALTERNATIVE_LANGUAGE_CODES = this.altLanguages.join(',');
      }
      else {
        opts.AZURE_SPEECH_ALTERNATIVE_LANGUAGE_CODES = '';
      }
      if (this.requestSnr) opts.AZURE_REQUEST_SNR = 1;
      if (this.profanityOption && this.profanityOption !== 'raw') opts.AZURE_PROFANITY_OPTION = this.profanityOption;
      if (this.azureServiceEndpoint) opts.AZURE_SERVICE_ENDPOINT = this.azureServiceEndpoint;
      if (this.initialSpeechTimeoutMs > 0) opts.AZURE_INITIAL_SPEECH_TIMEOUT_MS = this.initialSpeechTimeoutMs;
      else if (this.timeout === 0) opts.AZURE_INITIAL_SPEECH_TIMEOUT_MS = 120000;  // lengthy
      opts.AZURE_USE_OUTPUT_FORMAT_DETAILED = 1;

      ep.addCustomEventListener(AzureTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
      ep.addCustomEventListener(AzureTranscriptionEvents.NoSpeechDetected, this._onNoSpeechDetected.bind(this, cs, ep));
      ep.addCustomEventListener(AzureTranscriptionEvents.VadDetected, this._onVadDetected.bind(this, cs, ep));
    }
    else if ('nuance' === this.vendor) {
      this.bugname = 'nuance_transcribe';
      if (!this.nuanceOptions.resultType) {
        this.nuanceOptions.resultType = this.interim ? 'partial' : 'final';
      }
      opts = {
        ...opts,
        NUANCE_ACCESS_TOKEN: this.sttCredentials.access_token,
        ...(this.nuanceOptions.topic) &&
          {NUANCE_TOPIC: this.nuanceOptions.topic},
        ...(this.nuanceOptions.utteranceDetectionMode) &&
          {NUANCE_UTTERANCE_DETECTION_MODE: this.nuanceOptions.utteranceDetectionMode},
        ...(this.nuanceOptions.punctuation) && {NUANCE_PUNCTUATION: this.nuanceOptions.punctuation},
        ...(this.nuanceOptions.profanityFilter) &&
          {NUANCE_FILTER_PROFANITY: this.nuanceOptions.profanityFilter},
        ...(this.nuanceOptions.includeTokenization) &&
          {NUANCE_INCLUDE_TOKENIZATION: this.nuanceOptions.includeTokenization},
        ...(this.nuanceOptions.discardSpeakerAdaptation) &&
          {NUANCE_DISCARD_SPEAKER_ADAPTATION: this.nuanceOptions.discardSpeakerAdaptation},
        ...(this.nuanceOptions.suppressCallRecording) &&
          {NUANCE_SUPPRESS_CALL_RECORDING: this.nuanceOptions.suppressCallRecording},
        ...(this.nuanceOptions.maskLoadFailures) &&
          {NUANCE_MASK_LOAD_FAILURES: this.nuanceOptions.maskLoadFailures},
        ...(this.nuanceOptions.suppressInitialCapitalization) &&
          {NUANCE_SUPPRES_INITIAL_CAPITALIZATION: this.nuanceOptions.suppressInitialCapitalization},
        ...(this.nuanceOptions.allowZeroBaseLmWeight)
          && {NUANCE_ALLOW_ZERO_BASE_LM_WEIGHT: this.nuanceOptions.allowZeroBaseLmWeight},
        ...(this.nuanceOptions.filterWakeupWord) &&
          {NUANCE_FILTER_WAKEUP_WORD: this.nuanceOptions.filterWakeupWord},
        ...(this.nuanceOptions.resultType) &&
          {NUANCE_RESULT_TYPE: this.nuanceOptions.resultType},
        ...(this.nuanceOptions.noInputTimeoutMs) &&
          {NUANCE_NO_INPUT_TIMEOUT_MS: this.nuanceOptions.noInputTimeoutMs},
        ...(this.nuanceOptions.recognitionTimeoutMs) &&
          {NUANCE_RECOGNITION_TIMEOUT_MS: this.nuanceOptions.recognitionTimeoutMs},
        ...(this.nuanceOptions.utteranceEndSilenceMs) &&
          {NUANCE_UTTERANCE_END_SILENCE_MS: this.nuanceOptions.utteranceEndSilenceMs},
        ...(this.nuanceOptions.maxHypotheses) &&
          {NUANCE_MAX_HYPOTHESES: this.nuanceOptions.maxHypotheses},
        ...(this.nuanceOptions.speechDomain) &&
          {NUANCE_SPEECH_DOMAIN: this.nuanceOptions.speechDomain},
        ...(this.nuanceOptions.formatting) &&
          {NUANCE_FORMATTING: this.nuanceOptions.formatting}
      };

      ep.addCustomEventListener(GoogleTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
      ep.addCustomEventListener(GoogleTranscriptionEvents.EndOfUtterance, this._onEndOfUtterance.bind(this, cs, ep));
      ep.addCustomEventListener(GoogleTranscriptionEvents.VadDetected, this._onVadDetected.bind(this, cs, ep));
    }
    await ep.set(opts)
      .catch((err) => this.logger.info(err, 'Error setting channel variables'));
  }

  _startTranscribing(ep) {
    this.logger.debug({
      vendor: this.vendor,
      locale: this.language,
      interim: this.interim,
      bugname: this.bugname
    }, 'Gather:_startTranscribing');
    ep.startTranscription({
      vendor: this.vendor,
      locale: this.language,
      interim: this.interim,
      bugname: this.bugname,
    }).catch((err) => {
      const {writeAlerts, AlertType} = this.cs.srf.locals;
      this.logger.error(err, 'TaskGather:_startTranscribing error');
      writeAlerts({
        account_sid: this.cs.accountSid,
        alert_type: AlertType.STT_FAILURE,
        vendor: this.vendor,
        detail: err.message
      });
    }).catch((err) => this.logger.info({err}, 'Error generating alert for tts failure'));
  }

  _startTimer() {
    if (0 === this.timeout) return;
    this._clearTimer();
    this._timeoutTimer = setTimeout(() => {
      if (this.isContinuousAsr) this._startAsrTimer();
      else this._resolve(this.digitBuffer.length >= this.minDigits ? 'dtmf-num-digits' : 'timeout');
    }, this.timeout);
  }

  _clearTimer() {
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  }

  _startAsrTimer() {
    assert(this.isContinuousAsr);
    this._clearAsrTimer();
    this._asrTimer = setTimeout(() => {
      this.logger.debug('_startAsrTimer - asr timer went off');
      this._resolve(this._bufferedTranscripts.length > 0 ? 'speech' : 'timeout');
    }, this.asrTimeout);
    this.logger.debug(`_startAsrTimer: set for ${this.asrTimeout}ms`);
  }

  _clearAsrTimer() {
    if (this._asrTimer) clearTimeout(this._asrTimer);
    this._asrTimer = null;
  }

  _startFinalAsrTimer() {
    this._clearFinalAsrTimer();
    this._finalAsrTimer = setTimeout(() => {
      this.logger.debug('_startFinalAsrTimer - final asr timer went off');
      this._resolve(this._bufferedTranscripts.length > 0 ? 'speech' : 'timeout');
    }, 1000);
    this.logger.debug('_startFinalAsrTimer: set for 1 second');
  }

  _clearFinalAsrTimer() {
    if (this._finalAsrTimer) clearTimeout(this._finalAsrTimer);
    this._finalAsrTimer = null;
  }

  _killAudio(cs) {
    if (!this.sayTask && !this.playTask && this.bargein) {
      if (this.ep?.connected && !this.playComplete) {
        this.logger.debug('Gather:_killAudio: killing playback of any audio');
        this.playComplete = true;
        this.ep.api('uuid_break', this.ep.uuid)
          .catch((err) => this.logger.info(err, 'Error killing audio'));
      }
      return;
    }
    if (this.sayTask && !this.sayTask.killed) {
      this.sayTask.removeAllListeners('playDone');
      this.sayTask.kill(cs);
      this.sayTask = null;
    }
    if (this.playTask && !this.playTask.killed) {
      this.playTask.removeAllListeners('playDone');
      this.playTask.kill(cs);
      this.playTask = null;
    }
  }

  _onTranscription(cs, ep, evt, fsEvent) {
    // make sure this is not a transcript from answering machine detection
    const bugname = fsEvent.getHeader('media-bugname');
    const finished = fsEvent.getHeader('transcription-session-finished');
    if (bugname && this.bugname !== bugname) return;

    if ('aws' === this.vendor && Array.isArray(evt) && evt.length > 0) evt = evt[0];
    if ('microsoft' === this.vendor) {
      const final = evt.RecognitionStatus === 'Success';
      if (final) {
        // don't sort based on confidence: https://github.com/Azure-Samples/cognitive-services-speech-sdk/issues/1463
        //const nbest = evt.NBest.sort((a, b) => b.Confidence - a.Confidence);
        const nbest = evt.NBest;
        const language_code = evt.PrimaryLanguage?.Language || this.language;
        evt = {
          is_final: true,
          language_code,
          alternatives: [
            {
              confidence: nbest[0].Confidence,
              transcript: nbest[0].Display
            }
          ]
        };
      }
      else {
        evt = {
          is_final: false,
          alternatives: [
            {
              transcript: evt.Text
            }
          ]
        };
      }
    }

    /* count words for bargein feature */
    const words = evt.alternatives[0].transcript.split(' ').length;
    const bufferedWords = this._bufferedTranscripts.reduce((count, e) => {
      return count + e.alternatives[0].transcript.split(' ').length;
    }, 0);

    if (evt.is_final) {
      if (evt.alternatives[0].transcript === '' && !this.callSession.callGone && !this.killed) {
        if ('microsoft' === this.vendor && finished === 'true') {
          this.logger.debug({evt}, 'TaskGather:_onTranscription - got empty transcript from old gather, disregarding');
        }
        else {
          this.logger.info({evt}, 'TaskGather:_onTranscription - got empty transcript, listen again');
          this._startTranscribing(ep);
        }
        return;
      }
      if (this.isContinuousAsr) {
        /* append the transcript and start listening again for asrTimeout */
        const t = evt.alternatives[0].transcript;
        if (t) {
          /* remove trailing punctuation */
          if (/[,;:\.!\?]$/.test(t)) {
            this.logger.debug('TaskGather:_onTranscription - removing trailing punctuation');
            evt.alternatives[0].transcript = t.slice(0, -1);
          }
          else this.logger.debug({t}, 'TaskGather:_onTranscription - no trailing punctuation');
        }
        this.logger.info({evt}, 'TaskGather:_onTranscription - got transcript during continous asr');
        this._bufferedTranscripts.push(evt);
        this._clearTimer();
        if (this._finalAsrTimer) {
          this._clearFinalAsrTimer();
          return this._resolve(this._bufferedTranscripts.length > 0 ? 'speech' : 'timeout');
        }
        this._startAsrTimer();
        return this._startTranscribing(ep);
      }
      else {
        if (this.bargein && (words + bufferedWords) < this.minBargeinWordCount) {
          this.logger.debug({evt, words, bufferedWords},
            'TaskGather:_onTranscription - final transcript but < min barge words');
          this._bufferedTranscripts.push(evt);
          this._startTranscribing(ep);
          return;
        }
        else {
          this._resolve('speech', evt);
        }
      }
    }
    else {
      /* google has a measure of stability:
        https://cloud.google.com/speech-to-text/docs/basics#streaming_responses
        others do not.
      */
      //const isStableEnough = typeof evt.stability === 'undefined' || evt.stability > GATHER_STABILITY_THRESHOLD;
      if (this.bargein && (words + bufferedWords) >= this.minBargeinWordCount) {
        if (!this.playComplete) {
          this.logger.debug({transcript: evt.alternatives[0].transcript}, 'killing audio due to speech');
          this.emit('vad');
        }
        this._killAudio(cs);
      }
      if (this.partialResultHook) {
        const b3 = this.getTracingPropagation();
        const httpHeaders = b3 && {b3};
        this.cs.requestor.request('verb:hook', this.partialResultHook,  Object.assign({speech: evt},
          this.cs.callInfo, httpHeaders));
      }
    }
  }
  _onEndOfUtterance(cs, ep) {
    this.logger.debug('TaskGather:_onEndOfUtterance');
    if (this.bargein && this.minBargeinWordCount === 0) {
      this._killAudio(cs);
    }

    if (!this.resolved && !this.killed && !this._bufferedTranscripts.length) {
      this._startTranscribing(ep);
    }
  }

  _onVadDetected(cs, ep) {
    if (this.bargein && this.minBargeinWordCount === 0) {
      this.logger.debug('TaskGather:_onVadDetected');
      this._killAudio(cs);
      this.emit('vad');
    }
  }

  _onNoSpeechDetected(cs, ep, evt, fsEvent) {
    if (!this.callSession.callGone && !this.killed) {
      const finished = fsEvent.getHeader('transcription-session-finished');
      if (this.vendor === 'microsoft' && finished === 'true') {
        this.logger.debug('TaskGather:_onNoSpeechDetected for old gather, ignoring');
      }
      else {
        this.logger.debug('TaskGather:_onNoSpeechDetected - listen again');
        this._startTranscribing(ep);
      }
      return;
    }
  }

  async _resolve(reason, evt) {
    this.logger.debug(`TaskGather:resolve with reason ${reason}`);
    if (this.resolved) return;

    this.resolved = true;
    clearTimeout(this.interDigitTimer);
    this._clearTimer();

    if (this.isContinuousAsr && reason.startsWith('speech')) {
      evt = {
        is_final: true,
        transcripts: this._bufferedTranscripts
      };
      this.logger.debug({evt}, 'TaskGather:resolve continuous asr');
    }
    else if (!this.isContinuousAsr && reason.startsWith('speech') && this._bufferedTranscripts.length) {
      compileTranscripts(this.logger, evt, this._bufferedTranscripts);
      this.logger.debug({evt}, 'TaskGather:resolve buffered results');
    }

    this.span.setAttributes({'stt.resolve': reason, 'stt.result': JSON.stringify(evt)});
    if (this.needsStt && this.ep && this.ep.connected) {
      this.ep.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.error({err}, 'Error stopping transcription'));
    }

    if (this.callSession && this.callSession.callGone) {
      this.logger.debug('TaskGather:_resolve - call is gone, not invoking web callback');
      this.notifyTaskDone();
      return;
    }

    try {
      if (reason.startsWith('dtmf')) {
        if (this.parentTask) this.parentTask.emit('dtmf', evt);
        else {
          this.emit('dtmf', evt);
          await this.performAction({digits: this.digitBuffer, reason: 'dtmfDetected'});
        }
      }
      else if (reason.startsWith('speech')) {
        if (this.parentTask) this.parentTask.emit('transcription', evt);
        else {
          this.emit('transcription', evt);
          await this.performAction({speech: evt, reason: 'speechDetected'});
        }
      }
      else if (reason.startsWith('timeout')) {
        if (this.parentTask) this.parentTask.emit('timeout', evt);
        else {
          this.emit('timeout', evt);
          await this.performAction({reason: 'timeout'});
        }
      }
    } catch (err) {  /*already logged error*/ }
    this.notifyTaskDone();
  }
}

module.exports = TaskGather;
