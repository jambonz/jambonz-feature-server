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
      opts = {
        ...opts,
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
        ...{AZURE_USE_OUTPUT_FORMAT_DETAILED: 1},
        ...(sttCredentials && {
          AZURE_SUBSCRIPTION_KEY: sttCredentials.api_key,
          AZURE_REGION: sttCredentials.region,
        }),
        ...(sttCredentials.use_custom_stt && sttCredentials.custom_stt_endpoint &&
          {AZURE_SERVICE_ENDPOINT_ID: sttCredentials.custom_stt_endpoint})
      };
    }
    else if ('nuance' === rOpts.vendor) {
      /**
       * Note: all nuance options are in recognizer.nuanceOptions, should migrate
       * other vendor settings to similar nested structure
       */
      const {nuanceOptions = {}} = rOpts;
      opts = {
        ...opts,
        NUANCE_ACCESS_TOKEN: sttCredentials.access_token,
        ...(nuanceOptions.topic) &&
          {NUANCE_TOPIC: nuanceOptions.topic},
        ...(nuanceOptions.utteranceDetectionMode) &&
          {NUANCE_UTTERANCE_DETECTION_MODE: nuanceOptions.utteranceDetectionMode},
        ...(nuanceOptions.punctuation) && {NUANCE_PUNCTUATION: nuanceOptions.punctuation},
        ...(nuanceOptions.profanityFilter) &&
          {NUANCE_FILTER_PROFANITY: nuanceOptions.profanityFilter},
        ...(nuanceOptions.includeTokenization) &&
          {NUANCE_INCLUDE_TOKENIZATION: nuanceOptions.includeTokenization},
        ...(nuanceOptions.discardSpeakerAdaptation) &&
          {NUANCE_DISCARD_SPEAKER_ADAPTATION: nuanceOptions.discardSpeakerAdaptation},
        ...(nuanceOptions.suppressCallRecording) &&
          {NUANCE_SUPPRESS_CALL_RECORDING: nuanceOptions.suppressCallRecording},
        ...(nuanceOptions.maskLoadFailures) &&
          {NUANCE_MASK_LOAD_FAILURES: nuanceOptions.maskLoadFailures},
        ...(nuanceOptions.suppressInitialCapitalization) &&
          {NUANCE_SUPPRESS_INITIAL_CAPITALIZATION: nuanceOptions.suppressInitialCapitalization},
        ...(nuanceOptions.allowZeroBaseLmWeight)
          && {NUANCE_ALLOW_ZERO_BASE_LM_WEIGHT: nuanceOptions.allowZeroBaseLmWeight},
        ...(nuanceOptions.filterWakeupWord) &&
          {NUANCE_FILTER_WAKEUP_WORD: nuanceOptions.filterWakeupWord},
        ...(nuanceOptions.resultType) &&
          {NUANCE_RESULT_TYPE: nuanceOptions.resultType || rOpts.interim ? 'partial' : 'final'},
        ...(nuanceOptions.noInputTimeoutMs) &&
          {NUANCE_NO_INPUT_TIMEOUT_MS: nuanceOptions.noInputTimeoutMs},
        ...(nuanceOptions.recognitionTimeoutMs) &&
          {NUANCE_RECOGNITION_TIMEOUT_MS: nuanceOptions.recognitionTimeoutMs},
        ...(nuanceOptions.utteranceEndSilenceMs) &&
          {NUANCE_UTTERANCE_END_SILENCE_MS: nuanceOptions.utteranceEndSilenceMs},
        ...(nuanceOptions.maxHypotheses) &&
          {NUANCE_MAX_HYPOTHESES: nuanceOptions.maxHypotheses},
        ...(nuanceOptions.speechDomain) &&
          {NUANCE_SPEECH_DOMAIN: nuanceOptions.speechDomain},
        ...(nuanceOptions.formatting) &&
          {NUANCE_FORMATTING: nuanceOptions.formatting}
      };
    }
    logger.debug({opts}, 'recognizer channel vars');
    return opts;
  };

  return {
    normalizeTranscription,
    setChannelVarsForStt
  };
};
