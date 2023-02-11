const {
  TaskName,
  AzureTranscriptionEvents,
  GoogleTranscriptionEvents,
  AwsTranscriptionEvents,
  NuanceTranscriptionEvents,
  DeepgramTranscriptionEvents,
  NvidiaTranscriptionEvents
} = require('./constants');

const stickyVars = {
  google: [
    'GOOGLE_SPEECH_HINTS',
    'GOOGLE_SPEECH_SEPARATE_RECOGNITION_PER_CHANNEL',
    'GOOGLE_SPEECH_PROFANITY_FILTER',
    'GOOGLE_SPEECH_ENABLE_AUTOMATIC_PUNCTUATION',
    'GOOGLE_SPEECH_ENABLE_WORD_TIME_OFFSETS',
    'GOOGLE_SPEECH_SINGLE_UTTERANCE',
    'GOOGLE_SPEECH_SPEAKER_DIARIZATION',
    'GOOGLE_SPEECH_USE_ENHANCED',
    'GOOGLE_SPEECH_ALTERNATIVE_LANGUAGE_CODES',
    'GOOGLE_SPEECH_METADATA_INTERACTION_TYPE',
    'GOOGLE_SPEECH_METADATA_INDUSTRY_NAICS_CODE'
  ],
  microsoft: [
    'AZURE_SPEECH_HINTS',
    'AZURE_SERVICE_ENDPOINT_ID',
    'AZURE_REQUEST_SNR',
    'AZURE_PROFANITY_OPTION',
    'AZURE_SERVICE_ENDPOINT',
    'AZURE_INITIAL_SPEECH_TIMEOUT_MS',
    'AZURE_USE_OUTPUT_FORMAT_DETAILED',
  ],
  deepgram: [
    'DEEPGRAM_SPEECH_KEYWORDS',
    'DEEPGRAM_API_KEY',
    'DEEPGRAM_SPEECH_TIER',
    'DEEPGRAM_SPEECH_MODEL',
    'DEEPGRAM_SPEECH_ENABLE_AUTOMATIC_PUNCTUATION',
    'DEEPGRAM_SPEECH_PROFANITY_FILTER',
    'DEEPGRAM_SPEECH_REDACT',
    'DEEPGRAM_SPEECH_DIARIZE',
    'DEEPGRAM_SPEECH_NER',
    'DEEPGRAM_SPEECH_ALTERNATIVES',
    'DEEPGRAM_SPEECH_NUMERALS',
    'DEEPGRAM_SPEECH_SEARCH',
    'DEEPGRAM_SPEECH_REPLACE',
    'DEEPGRAM_SPEECH_ENDPOINTING',
    'DEEPGRAM_SPEECH_VAD_TURNOFF',
    'DEEPGRAM_SPEECH_TAG'
  ],
  aws: [
    'AWS_VOCABULARY_NAME',
    'AWS_VOCABULARY_FILTER_METHOD',
    'AWS_VOCABULARY_FILTER_NAME'
  ],
  nuance: [
    'NUANCE_ACCESS_TOKEN',
    'NUANCE_KRYPTON_ENDPOINT',
    'NUANCE_TOPIC',
    'NUANCE_UTTERANCE_DETECTION_MODE',
    'NUANCE_FILTER_PROFANITY',
    'NUANCE_INCLUDE_TOKENIZATION',
    'NUANCE_DISCARD_SPEAKER_ADAPTATION',
    'NUANCE_SUPPRESS_CALL_RECORDING',
    'NUANCE_MASK_LOAD_FAILURES',
    'NUANCE_SUPPRESS_INITIAL_CAPITALIZATION',
    'NUANCE_ALLOW_ZERO_BASE_LM_WEIGHT',
    'NUANCE_FILTER_WAKEUP_WORD',
    'NUANCE_NO_INPUT_TIMEOUT_MS',
    'NUANCE_RECOGNITION_TIMEOUT_MS',
    'NUANCE_UTTERANCE_END_SILENCE_MS',
    'NUANCE_MAX_HYPOTHESES',
    'NUANCE_SPEECH_DOMAIN',
    'NUANCE_FORMATTING',
    'NUANCE_RESOURCES'
  ],
  ibm: [
    'IBM_ACCESS_TOKEN',
    'IBM_SPEECH_REGION',
    'IBM_SPEECH_INSTANCE_ID',
    'IBM_SPEECH_MODEL',
    'IBM_SPEECH_LANGUAGE_CUSTOMIZATION_ID',
    'IBM_SPEECH_ACOUSTIC_CUSTOMIZATION_ID',
    'IBM_SPEECH_BASE_MODEL_VERSION',
    'IBM_SPEECH_WATSON_METADATA',
    'IBM_SPEECH_WATSON_LEARNING_OPT_OUT'
  ],
  nvidia: [
    'NVIDIA_HINTS'
  ]
};

const normalizeDeepgram = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  const alternatives = (evt.channel?.alternatives || [])
    .map((alt) => ({
      confidence: alt.confidence,
      transcript: alt.transcript,
    }));

  return {
    language_code: language,
    channel_tag: channel,
    is_final: evt.is_final,
    alternatives: [alternatives[0]],
    vendor: {
      name: 'deepgram',
      evt: copy
    }
  };
};

const normalizeNvidia = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  const alternatives = (evt.alternatives || [])
    .map((alt) => ({
      confidence: alt.confidence,
      transcript: alt.transcript,
    }));
  return {
    language_code: language,
    channel_tag: channel,
    is_final: evt.is_final,
    alternatives,
    vendor: {
      name: 'nvidia',
      evt: copy
    }
  };
};

const normalizeIbm = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  //const idx = evt.result_index;
  const result = evt.results[0];

  return {
    language_code: language,
    channel_tag: channel,
    is_final: result.final,
    alternatives: result.alternatives,
    vendor: {
      name: 'ibm',
      evt: copy
    }
  };
};

const normalizeGoogle = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  return {
    language_code: language,
    channel_tag: channel,
    is_final: evt.is_final,
    alternatives: [evt.alternatives[0]],
    vendor: {
      name: 'google',
      evt: copy
    }
  };
};

const normalizeNuance = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  return {
    language_code: language,
    channel_tag: channel,
    is_final: evt.is_final,
    alternatives: [evt.alternatives[0]],
    vendor: {
      name: 'nuance',
      evt: copy
    }
  };
};

const normalizeMicrosoft = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
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

  return {
    language_code,
    channel_tag: channel,
    is_final: evt.RecognitionStatus === 'Success',
    alternatives: [alternatives[0]],
    vendor: {
      name: 'microsoft',
      evt: copy
    }
  };
};

const normalizeAws = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  return {
    language_code: language,
    channel_tag: channel,
    is_final: evt[0].is_final,
    alternatives: evt[0].alternatives,
    vendor: {
      name: 'aws',
      evt: copy
    }
  };
};


module.exports = (logger) => {
  const normalizeTranscription = (evt, vendor, channel, language) => {

    logger.debug({ evt, vendor, channel, language }, 'normalizeTranscription');
    switch (vendor) {
      case 'deepgram':
        return normalizeDeepgram(evt, channel, language);
      case 'microsoft':
        return normalizeMicrosoft(evt, channel, language);
      case 'google':
        return normalizeGoogle(evt, channel, language);
      case 'aws':
        return normalizeAws(evt, channel, language);
      case 'nuance':
        return normalizeNuance(evt, channel, language);
      case 'ibm':
        return normalizeIbm(evt, channel, language);
      case 'nvidia':
        return normalizeNvidia(evt, channel, language);
      default:
        logger.error(`Unknown vendor ${vendor}`);
        return evt;
    }
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
        ...(rOpts.hints.length > 0 && typeof rOpts.hints[0] === 'string' &&
          {GOOGLE_SPEECH_HINTS: rOpts.hints.join(',')}),
        ...(rOpts.hints.length > 0 && typeof rOpts.hints[0] === 'object' &&
          {GOOGLE_SPEECH_HINTS: JSON.stringify(rOpts.hints)}),
        ...(typeof rOpts.hintsBoost === 'number' &&
          {GOOGLE_SPEECH_HINTS_BOOST: rOpts.hintsBoost}),
        ...(rOpts.altLanguages.length > 0 &&
          {GOOGLE_SPEECH_ALTERNATIVE_LANGUAGE_CODES: rOpts.altLanguages.join(',')}),
        ...(rOpts.interactionType &&
          {GOOGLE_SPEECH_METADATA_INTERACTION_TYPE: rOpts.interactionType}),
        ...{GOOGLE_SPEECH_MODEL: rOpts.model || (task.name === TaskName.Gather ? 'latest_short' : 'phone_call')},
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
        ...(rOpts.hints.length > 0 && typeof rOpts.hints[0] === 'string' &&
          {AZURE_SPEECH_HINTS: rOpts.hints.map((h) => h.trim()).join(',')}),
        ...(rOpts.hints.length > 0 && typeof rOpts.hints[0] === 'object' &&
          {AZURE_SPEECH_HINTS: rOpts.hints.map((h) => h.phrase).join(',')}),
        ...(rOpts.altLanguages && rOpts.altLanguages.length > 0 &&
          {AZURE_SERVICE_ENDPOINT_ID: rOpts.sttCredentials}),
        ...(rOpts.requestSnr && {AZURE_REQUEST_SNR: 1}),
        ...(rOpts.profanityOption && {AZURE_PROFANITY_OPTION: rOpts.profanityOption}),
        ...(rOpts.azureServiceEndpoint && {AZURE_SERVICE_ENDPOINT: rOpts.azureServiceEndpoint}),
        ...(rOpts.initialSpeechTimeoutMs > 0 &&
          {AZURE_INITIAL_SPEECH_TIMEOUT_MS: rOpts.initialSpeechTimeoutMs}),
        ...(rOpts.requestSnr && {AZURE_REQUEST_SNR: 1}),
        ...(rOpts.audioLogging && {AZURE_AUDIO_LOGGING: 1}),
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
        ...(sttCredentials.access_token) &&
          {NUANCE_ACCESS_TOKEN: sttCredentials.access_token},
        ...(sttCredentials.krypton_endpoint) &&
          {NUANCE_KRYPTON_ENDPOINT: sttCredentials.krypton_endpoint},
        ...(nuanceOptions.topic) &&
          {NUANCE_TOPIC: nuanceOptions.topic},
        ...(nuanceOptions.utteranceDetectionMode) &&
          {NUANCE_UTTERANCE_DETECTION_MODE: nuanceOptions.utteranceDetectionMode},
        ...(nuanceOptions.punctuation || rOpts.punctuation) && {NUANCE_PUNCTUATION: nuanceOptions.punctuation},
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
          {NUANCE_FORMATTING: nuanceOptions.formatting},
        ...(nuanceOptions.resources) &&
          {NUANCE_RESOURCES: JSON.stringify(nuanceOptions.resources)},
      };
    }
    else if ('deepgram' === rOpts.vendor) {
      const {deepgramOptions = {}} = rOpts;
      opts = {
        ...opts,
        ...(sttCredentials.api_key) &&
          {DEEPGRAM_API_KEY: sttCredentials.api_key},
        ...(deepgramOptions.tier) &&
          {DEEPGRAM_SPEECH_TIER: deepgramOptions.tier},
        ...(deepgramOptions.model) &&
          {DEEPGRAM_SPEECH_MODEL: deepgramOptions.model},
        ...(deepgramOptions.punctuate) &&
          {DEEPGRAM_SPEECH_ENABLE_AUTOMATIC_PUNCTUATION: 1},
        ...(deepgramOptions.profanityFilter) &&
          {DEEPGRAM_SPEECH_PROFANITY_FILTER: 1},
        ...(deepgramOptions.redact) &&
          {DEEPGRAM_SPEECH_REDACT: 1},
        ...(deepgramOptions.diarize) &&
          {DEEPGRAM_SPEECH_DIARIZE: 1},
        ...(deepgramOptions.diarizeVersion) &&
          {DEEPGRAM_SPEECH_DIARIZE_VERSION: deepgramOptions.diarizeVersion},
        ...(deepgramOptions.ner) &&
          {DEEPGRAM_SPEECH_NER: 1},
        ...(deepgramOptions.alternatives) &&
          {DEEPGRAM_SPEECH_ALTERNATIVES: deepgramOptions.alternatives},
        ...(deepgramOptions.numerals) &&
          {DEEPGRAM_SPEECH_NUMERALS: deepgramOptions.numerals},
        ...(deepgramOptions.search) &&
          {DEEPGRAM_SPEECH_SEARCH: deepgramOptions.search.join(',')},
        ...(deepgramOptions.replace) &&
          {DEEPGRAM_SPEECH_REPLACE: deepgramOptions.replace.join(',')},
        ...(rOpts.hints.length > 0 && typeof rOpts.hints[0] === 'string' &&
          {DEEPGRAM_SPEECH_KEYWORDS: rOpts.hints.map((h) => h.trim()).join(',')}),
        ...(rOpts.hints.length > 0 && typeof rOpts.hints[0] === 'object' &&
          {DEEPGRAM_SPEECH_KEYWORDS: rOpts.hints.map((h) => h.phrase).join(',')}),
        ...(deepgramOptions.keywords) &&
          {DEEPGRAM_SPEECH_KEYWORDS: deepgramOptions.keywords.join(',')},
        ...('endpointing' in deepgramOptions) &&
          {DEEPGRAM_SPEECH_ENDPOINTING: deepgramOptions.endpointing},
        ...(deepgramOptions.vadTurnoff) &&
          {DEEPGRAM_SPEECH_VAD_TURNOFF: deepgramOptions.vadTurnoff},
        ...(deepgramOptions.tag) &&
          {DEEPGRAM_SPEECH_TAG: deepgramOptions.tag}
      };
    }
    else if ('ibm' === rOpts.vendor) {
      const {ibmOptions = {}} = rOpts;
      opts = {
        ...opts,
        ...(sttCredentials.access_token) &&
          {IBM_ACCESS_TOKEN: sttCredentials.access_token},
        ...(sttCredentials.stt_region) &&
          {IBM_SPEECH_REGION: sttCredentials.stt_region},
        ...(sttCredentials.instance_id) &&
          {IBM_SPEECH_INSTANCE_ID: sttCredentials.instance_id},
        ...(ibmOptions.model) &&
          {IBM_SPEECH_MODEL: ibmOptions.model},
        ...(ibmOptions.language_customization_id) &&
          {IBM_SPEECH_LANGUAGE_CUSTOMIZATION_ID: ibmOptions.language_customization_id},
        ...(ibmOptions.acoustic_customization_id) &&
          {IBM_SPEECH_ACOUSTIC_CUSTOMIZATION_ID: ibmOptions.acoustic_customization_id},
        ...(ibmOptions.baseModelVersion) &&
          {IBM_SPEECH_BASE_MODEL_VERSION: ibmOptions.baseModelVersion},
        ...(ibmOptions.watsonMetadata) &&
          {IBM_SPEECH_WATSON_METADATA: ibmOptions.watsonMetadata},
        ...(ibmOptions.watsonLearningOptOut) &&
          {IBM_SPEECH_WATSON_LEARNING_OPT_OUT: ibmOptions.watsonLearningOptOut}
      };
    }
    else if ('nvidia' === rOpts.vendor) {
      const {nvidiaOptions = {}} = rOpts;
      opts = {
        ...opts,
        ...((nvidiaOptions.profanityFilter || rOpts.profanityFilter) && {NVIDIA_PROFANITY_FILTER: 1}),
        ...(!(nvidiaOptions.profanityFilter || rOpts.profanityFilter) && {NVIDIA_PROFANITY_FILTER: 0}),
        ...((nvidiaOptions.punctuation || rOpts.punctuation) && {NVIDIA_PUNCTUATION: 1}),
        ...(!(nvidiaOptions.punctuation || rOpts.punctuation) && {NVIDIA_PUNCTUATION: 0}),
        ...((rOpts.words || nvidiaOptions.wordTimeOffsets) && {NVIDIA_WORD_TIME_OFFSETS: 1}),
        ...(!(rOpts.words || nvidiaOptions.wordTimeOffsets) && {NVIDIA_WORD_TIME_OFFSETS: 0}),
        ...(nvidiaOptions.maxAlternatives && {NVIDIA_MAX_ALTERNATIVES: nvidiaOptions.maxAlternatives}),
        ...(!nvidiaOptions.maxAlternatives && {NVIDIA_MAX_ALTERNATIVES: 1}),
        ...(rOpts.model && {NVIDIA_MODEL: rOpts.model}),
        ...(nvidiaOptions.rivaUri && {NVIDIA_RIVA_URI: nvidiaOptions.rivaUri}),
        ...(nvidiaOptions.verbatimTranscripts && {NVIDIA_VERBATIM_TRANSCRIPTS: 1}),
        ...(rOpts.diarization && {NVIDIA_SPEAKER_DIARIZATION: 1}),
        ...(rOpts.diarization && rOpts.diarizationMaxSpeakers > 0 &&
          {NVIDIA_DIARIZATION_SPEAKER_COUNT: rOpts.diarizationMaxSpeakers}),
        ...(rOpts.separateRecognitionPerChannel && {NVIDIA_SEPARATE_RECOGNITION_PER_CHANNEL: 1}),
        ...(rOpts.hints.length > 0 && typeof rOpts.hints[0] === 'string' &&
          {NVIDIA_HINTS: rOpts.hints.join(',')}),
        ...(rOpts.hints.length > 0 && typeof rOpts.hints[0] === 'object' &&
          {NVIDIA_HINTS: JSON.stringify(rOpts.hints)}),
        ...(typeof rOpts.hintsBoost === 'number' &&
          {NVIDIA_HINTS_BOOST: rOpts.hintsBoost}),
        ...(nvidiaOptions.customConfiguration &&
          {NVIDIA_CUSTOM_CONFIGURATION: JSON.stringify(nvidiaOptions.customConfiguration)}),
      };
    }

    stickyVars[rOpts.vendor].forEach((key) => {
      if (!opts[key]) opts[key] = '';
    });
    logger.debug({opts}, 'recognizer channel vars');
    return opts;
  };

  const removeSpeechListeners = (ep) => {
    ep.removeCustomEventListener(GoogleTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(GoogleTranscriptionEvents.EndOfUtterance);
    ep.removeCustomEventListener(GoogleTranscriptionEvents.VadDetected);

    ep.removeCustomEventListener(AwsTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(AwsTranscriptionEvents.VadDetected);

    ep.removeCustomEventListener(AzureTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(AzureTranscriptionEvents.NoSpeechDetected);
    ep.removeCustomEventListener(AzureTranscriptionEvents.VadDetected);

    ep.removeCustomEventListener(NuanceTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(NuanceTranscriptionEvents.TranscriptionComplete);
    ep.removeCustomEventListener(NuanceTranscriptionEvents.StartOfSpeech);
    ep.removeCustomEventListener(NuanceTranscriptionEvents.Error);
    ep.removeCustomEventListener(NuanceTranscriptionEvents.VadDetected);

    ep.removeCustomEventListener(DeepgramTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(DeepgramTranscriptionEvents.Connect);
    ep.removeCustomEventListener(DeepgramTranscriptionEvents.ConnectFailure);

    ep.removeCustomEventListener(NvidiaTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(NvidiaTranscriptionEvents.TranscriptionComplete);
    ep.removeCustomEventListener(NvidiaTranscriptionEvents.StartOfSpeech);
    ep.removeCustomEventListener(NvidiaTranscriptionEvents.Error);
    ep.removeCustomEventListener(NvidiaTranscriptionEvents.VadDetected);
  };

  const setSpeechCredentialsAtRuntime = (recognizer) => {
    if (!recognizer) return;
    if (recognizer.vendor === 'nuance') {
      const {clientId, secret} = recognizer.nuanceOptions || {};
      if (clientId && secret) return {client_id: clientId, secret};
    }
    else if (recognizer.vendor === 'nvidia') {
      const {rivaUri} = recognizer.nvidiaOptions || {};
      if (rivaUri) return {riva_uri: rivaUri};
    }
    else if (recognizer.vendor === 'deepgram') {
      const {apiKey} = recognizer.deepgramOptions || {};
      if (apiKey) return {api_key: apiKey};
    }
    else if (recognizer.vendor === 'ibm') {
      const {ttsApiKey, ttsRegion, sttApiKey, sttRegion, instanceId} = recognizer.ibmOptions || {};
      if (ttsApiKey || sttApiKey) return {
        tts_api_key: ttsApiKey,
        tts_region: ttsRegion,
        stt_api_key: sttApiKey,
        stt_region: sttRegion,
        instance_id: instanceId
      };
    }
  };

  return {
    normalizeTranscription,
    setChannelVarsForStt,
    removeSpeechListeners,
    setSpeechCredentialsAtRuntime
  };
};
