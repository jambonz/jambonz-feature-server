const {TaskName} = require('./constants');

module.exports = (logger) => {
  const normalizeTranscription = (evt, vendor, channel, language) => {
    let newEvent = JSON.parse(JSON.stringify(evt));

    /* add in channel_tag and provide the full vendor-specific event */
    newEvent = {
      ...newEvent,
      language_code: language,
      channel_tag: channel,
      vendor: {...evt, name: vendor}
    };


    if ('aws' === vendor && Array.isArray(evt) && evt.length > 0) {
      newEvent = {
        ...newEvent,
        ...evt[0]
      };
    }
    else if ('microsoft' === vendor) {
      const nbest = evt.NBest;
      const language_code = evt.PrimaryLanguage?.Language || language;
      const alternatives = nbest ? nbest.map((n) => {
        return {
          confidence: n.Confidence,
          transcript: n.Display
        };
      }) :
        [
          {
            transcript: evt.DisplayText || evt.Text
          }
        ];

      newEvent = {
        ...newEvent,
        is_final: evt.RecognitionStatus === 'Success',
        channel,
        language_code,
        alternatives
      };
    }
    logger.debug({newEvent}, 'normalized transcription');
    return newEvent;
  };

  const setChannelVarsForStt = (task, sttCredentials, rOpts = {}) => {
    let opts = {};
    const {enable, voiceMs = 0, mode = -1} = rOpts.vad || {};
    const vad = {enable, voiceMs, mode};

    /* voice activity detection works across vendors */
    opts = {
      ...opts,
      ...(vad.enable && {START_RECOGNIZING_ON_VAD: 1}),
      ...(vad.enable && vad.voiceMs && {RECOGNIZER_VAD_VOICE_MS: vad.voiceMs}),
      ...(vad.enable && typeof vad.mode === 'number' && {RECOGNIZER_VAD_MODE: vad.mode}),
    };

    if ('google' === rOpts.vendor) {
      opts = {
        ...opts,
        ...(sttCredentials &&
          {GOOGLE_APPLICATION_CREDENTIALS: JSON.stringify(sttCredentials.credentials)}),
        ...(rOpts.enhancedModel &&
            {GOOGLE_SPEECH_USE_ENHANCED: 1}),
        ...(rOpts.separateRecognitionPerChannel &&
          {GOOGLE_SPEECH_SEPARATE_RECOGNITION_PER_CHANNEL: 1}),
        ...(rOpts.profanityFilter &&
          {GOOGLE_SPEECH_PROFANITY_FILTER: 1}),
        ...(rOpts.punctuation &&
          {GOOGLE_SPEECH_ENABLE_AUTOMATIC_PUNCTUATION: 1}),
        ...(rOpts.words &&
          {GOOGLE_SPEECH_ENABLE_WORD_TIME_OFFSETS: 1}),
        ...((rOpts.singleUtterance ||  task.name === TaskName.Gather) &&
          {GOOGLE_SPEECH_SINGLE_UTTERANCE: 1}),
        ...(rOpts.diarization &&
          {GOOGLE_SPEECH_SPEAKER_DIARIZATION: 1}),
        ...(rOpts.diarization && rOpts.diarizationMinSpeakers > 0 &&
          {GOOGLE_SPEECH_SPEAKER_DIARIZATION_MIN_SPEAKER_COUNT: rOpts.diarizationMinSpeakers}),
        ...(rOpts.diarization && rOpts.diarizationMaxSpeakers > 0 &&
          {GOOGLE_SPEECH_SPEAKER_DIARIZATION_MAX_SPEAKER_COUNT: rOpts.diarizationMaxSpeakers}),
        ...(rOpts.enhancedModel === false &&
          {GOOGLE_SPEECH_USE_ENHANCED: 0}),
        ...(rOpts.separateRecognitionPerChannel === false &&
          {GOOGLE_SPEECH_SEPARATE_RECOGNITION_PER_CHANNEL: 0}),
        ...(rOpts.profanityFilter === false &&
          {GOOGLE_SPEECH_PROFANITY_FILTER: 0}),
        ...(rOpts.punctuation === false &&
          {GOOGLE_SPEECH_ENABLE_AUTOMATIC_PUNCTUATION: 0}),
        ...(rOpts.words  == false &&
          {GOOGLE_SPEECH_ENABLE_WORD_TIME_OFFSETS: 0}),
        ...((rOpts.singleUtterance === false || task.name === TaskName.Transcribe) &&
          {GOOGLE_SPEECH_SINGLE_UTTERANCE: 0}),
        ...(rOpts.diarization === false &&
          {GOOGLE_SPEECH_SPEAKER_DIARIZATION: 0}),
        ...(rOpts.hints.length > 0 &&
          {GOOGLE_SPEECH_HINTS: rOpts.hints.join(',')}),
        ...(typeof rOpts.hintsBoost === 'number' &&
          {GOOGLE_SPEECH_HINTS_BOOST: rOpts.hintsBoost}),
        ...(rOpts.altLanguages.length > 0 &&
          {GOOGLE_SPEECH_ALTERNATIVE_LANGUAGE_CODES: rOpts.altLanguages.join(',')}),
        ...(rOpts.interactionType &&
          {GOOGLE_SPEECH_METADATA_INTERACTION_TYPE: rOpts.interactionType}),
        ...{GOOGLE_SPEECH_MODEL: rOpts.model || (task.name === TaskName.Gather ? 'command_and_search' : 'phone_call')},
        ...(rOpts.naicsCode > 0 &&
          {GOOGLE_SPEECH_METADATA_INDUSTRY_NAICS_CODE: rOpts.naicsCode}),
      };
    }
    else if (['aws', 'polly'].includes(rOpts.vendor)) {
      opts = {
        ...opts,
        ...(rOpts.vocabularyName && {AWS_VOCABULARY_NAME: rOpts.vocabularyName}),
        ...(rOpts.vocabularyFilterName && {AWS_VOCABULARY_FILTER_NAME: rOpts.vocabularyFilterName}),
        ...(rOpts.filterMethod && {AWS_VOCABULARY_FILTER_METHOD: rOpts.filterMethod}),
        ...(sttCredentials && {
          AWS_ACCESS_KEY_ID: sttCredentials.accessKeyId,
          AWS_SECRET_ACCESS_KEY: sttCredentials.secretAccessKey,
          AWS_REGION: sttCredentials.region
        }),
      };
    }
    else if ('microsoft' === rOpts.vendor) {
      const {api_key, region, use_custom_stt, custom_stt_endpoint} = sttCredentials || {};
      opts = {
        ...opts,
        ...({ MICROSOFT_SPEECH_API_KEY: api_key, AZURE_REGION: region}),
        ...(use_custom_stt && custom_stt_endpoint && {AZURE_SERVICE_ENDPOINT_ID: custom_stt_endpoint}),
        ...(rOpts.hints  && rOpts.hints.length > 0 &&
          {AZURE_SPEECH_HINTS: rOpts.hints.map((h) => h.trim()).join(',')}),
        ...(rOpts.altLanguages && rOpts.altLanguages.length > 0 &&
          {AZURE_SERVICE_ENDPOINT_ID: rOpts.sttCredentials}),
        ...(rOpts.requestSnr && {AZURE_REQUEST_SNR: 1}),
        ...(rOpts.profanityOption && {AZURE_PROFANITY_OPTION: rOpts.profanityOption}),
        ...(rOpts.azureServiceEndpoint && {AZURE_SERVICE_ENDPOINT: rOpts.azureServiceEndpoint}),
        ...(rOpts.initialSpeechTimeoutMs > 0 &&
          {AZURE_INITIAL_SPEECH_TIMEOUT_MS: rOpts.initialSpeechTimeoutMs}),
        ...(rOpts.requestSnr && {AZURE_REQUEST_SNR: 1}),
        ...{AZURE_USE_OUTPUT_FORMAT_DETAILED: 1}
      };
    }
    else if ('nuance' === this.vendor) {
      /**
       * Note: all nuance options are in recognizer.nuanceOptions, should migrate
       * other vendor settings to similar structure
       */
      const {nuanceOptions = {}} = rOpts;
      const {clientId, secret} = nuanceOptions;
      if (clientId && secret) {
        sttCredentials = {clientId, secret};
      }
      if (!nuanceOptions.resultType) nuanceOptions.resultType = this.interim ? 'partial' : 'final';

      opts = {
        ...opts,
        NUANCE_ACCESS_TOKEN: sttCredentials.access_token,
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
          {NUANCE_SUPPRESS_INITIAL_CAPITALIZATION: this.nuanceOptions.suppressInitialCapitalization},
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
    }
    return opts;
  };

  return {
    normalizeTranscription,
    setChannelVarsForStt
  };
};
