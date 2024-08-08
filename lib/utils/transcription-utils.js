const {
  TaskName,
} = require('./constants.json');

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
    'AZURE_SPEECH_ALTERNATIVE_LANGUAGE_CODES',
    'AZURE_SERVICE_ENDPOINT',
    'AZURE_INITIAL_SPEECH_TIMEOUT_MS',
    'AZURE_USE_OUTPUT_FORMAT_DETAILED',
    'AZURE_SPEECH_SEGMENTATION_SILENCE_TIMEOUT_MS'
  ],
  deepgram: [
    'DEEPGRAM_SPEECH_KEYWORDS',
    'DEEPGRAM_API_KEY',
    'DEEPGRAM_SPEECH_TIER',
    'DEEPGRAM_SPEECH_MODEL',
    'DEEPGRAM_SPEECH_ENABLE_SMART_FORMAT',
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
    'DEEPGRAM_SPEECH_UTTERANCE_END_MS',
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
  ],
  cobalt: [
    'COBALT_SPEECH_HINTS',
    'COBALT_COMPILED_CONTEXT_DATA',
    'COBALT_METADATA'
  ],
  soniox: [
    'SONIOX_PROFANITY_FILTER',
    'SONIOX_MODEL'
  ],
  assemblyai: [
    'ASSEMBLYAI_API_KEY',
    'ASSEMBLYAI_WORD_BOOST'
  ]
};

/**
 * @see https://developers.deepgram.com/docs/models-languages-overview
 */
const optimalDeepramModels = {
  zh: ['base', 'base'],
  'zh-CN':['base', 'base'],
  'zh-TW': ['base', 'base'],
  da: ['enhanced', 'enhanced'],
  en: ['nova-2-phonecall', 'nova-2'],
  'en-US': ['nova-2-phonecall', 'nova-2'],
  'en-AU': ['nova-2', 'nova-2'],
  'en-GB': ['nova-2', 'nova-2'],
  'en-IN': ['nova-2', 'nova-2'],
  'en-NZ': ['nova-2', 'nova-2'],
  nl: ['nova-2', 'nova-2'],
  fr: ['nova-2', 'nova-2'],
  'fr-CA': ['nova-2', 'nova-2'],
  de: ['nova-2', 'nova-2'],
  hi: ['nova-2', 'nova-2'],
  'hi-Latn': ['nova-2', 'nova-2'],
  id: ['base', 'base'],
  it: ['nova-2', 'nova-2'],
  ja: ['enhanced', 'enhanced'],
  ko: ['nova-2', 'nova-2'],
  no: ['nova-2', 'nova-2'],
  pl: ['nova-2', 'nova-2'],
  pt: ['nova-2', 'nova-2'],
  'pt-BR': ['nova-2', 'nova-2'],
  'pt-PT': ['nova-2', 'nova-2'],
  ru: ['nova-2', 'nova-2'],
  es: ['nova-2', 'nova-2'],
  'es-419': ['nova-2', 'nova-2'],
  'es-LATAM': ['enhanced', 'enhanced'],
  sv: ['nova-2', 'nova-2'],
  ta: ['enhanced', 'enhanced'],
  taq: ['enhanced', 'enhanced'],
  tr: ['nova-2', 'nova-2'],
  uk: ['nova-2', 'nova-2']
};

const selectDefaultDeepgramModel = (task, language) => {
  if (language in optimalDeepramModels) {
    const [gather, transcribe] = optimalDeepramModels[language];
    return task.name === TaskName.Gather ? gather : transcribe;
  }
  return 'base';
};

const consolidateTranscripts = (bufferedTranscripts, channel, language, vendor) => {
  if (bufferedTranscripts.length === 1) return bufferedTranscripts[0];
  let totalConfidence = 0;
  const finalTranscript = bufferedTranscripts.reduce((acc, evt) => {
    totalConfidence += evt.alternatives[0].confidence;

    let newTranscript = evt.alternatives[0].transcript;

    // If new transcript consists only of digits, spaces, and a trailing comma or period
    if (newTranscript.match(/^[\d\s]+[,.]?$/)) {
      newTranscript = newTranscript.replace(/\s/g, '');  // Remove all spaces
      if (newTranscript.endsWith(',')) {
        newTranscript = newTranscript.slice(0, -1);  // Remove the trailing comma
      } else if (newTranscript.endsWith('.')) {
        newTranscript = newTranscript.slice(0, -1);  // Remove the trailing period
      }
    }

    const lastChar = acc.alternatives[0].transcript.slice(-1);
    const firstChar = newTranscript.charAt(0);

    if (lastChar.match(/\d/) && firstChar.match(/\d/)) {
      acc.alternatives[0].transcript += newTranscript;
    } else {
      acc.alternatives[0].transcript += ` ${newTranscript}`;
    }

    return acc;
  }, {
    language_code: language,
    channel_tag: channel,
    is_final: true,
    alternatives: [{
      transcript: ''
    }]
  });
  finalTranscript.alternatives[0].confidence = bufferedTranscripts.length === 1 ?
    bufferedTranscripts[0].alternatives[0].confidence :
    totalConfidence / bufferedTranscripts.length;
  finalTranscript.alternatives[0].transcript = finalTranscript.alternatives[0].transcript.trim();
  finalTranscript.vendor = {
    name: vendor,
    evt: bufferedTranscripts
  };
  return finalTranscript;
};

const compileSonioxTranscripts = (finalWordChunks, channel, language) => {
  const words = finalWordChunks.flat();
  const transcript = words.reduce((acc, word) => {
    if (word.text === '<end>') return acc;
    if ([',', '.', '?', '!'].includes(word.text)) return `${acc}${word.text}`;
    return `${acc} ${word.text}`;
  }, '').trim();
  const realWords = words.filter((word) => ![',.!?;'].includes(word.text) && word.text !== '<end>');
  const confidence = realWords.reduce((acc, word) => acc + word.confidence, 0) / realWords.length;
  const alternatives = [{transcript, confidence}];
  return {
    language_code: language,
    channel_tag: channel,
    is_final: true,
    alternatives,
    vendor: {
      name: 'soniox',
      evt: words
    }
  };
};

const normalizeSoniox = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));

  /* an <end> token indicates the end of an utterance */
  const endTokenPos = evt.words.map((w) => w.text).indexOf('<end>');
  const endpointReached = endTokenPos !== -1;
  const words = endpointReached ? evt.words.slice(0, endTokenPos) : evt.words;

  /* note: we can safely ignore words after the <end> token as they will be returned again */
  const finalWords = words.filter((word) => word.is_final);
  const nonFinalWords = words.filter((word) => !word.is_final);

  const is_final = endpointReached && finalWords.length > 0;
  const transcript = words.reduce((acc, word) => {
    if ([',', '.', '?', '!'].includes(word.text)) return `${acc}${word.text}`;
    else return `${acc} ${word.text}`;
  }, '').trim();
  const realWords = words.filter((word) => ![',.!?;'].includes(word.text) && word.text !== '<end>');
  const confidence = realWords.reduce((acc, word) => acc + word.confidence, 0) / realWords.length;
  const alternatives = [{transcript, confidence}];
  return {
    language_code: language,
    channel_tag: channel,
    is_final,
    alternatives,
    vendor: {
      name: 'soniox',
      endpointReached,
      evt: copy,
      finalWords,
      nonFinalWords
    }
  };
};

const normalizeDeepgram = (evt, channel, language, shortUtterance) => {
  const copy = JSON.parse(JSON.stringify(evt));
  const alternatives = (evt.channel?.alternatives || [])
    .map((alt) => ({
      confidence: alt.confidence,
      transcript: alt.transcript,
    }));

  /**
   * note difference between is_final and speech_final in Deepgram:
   * https://developers.deepgram.com/docs/understand-endpointing-interim-results
   */
  return {
    language_code: language,
    channel_tag: channel,
    is_final: shortUtterance ? evt.is_final : evt.speech_final,
    alternatives: alternatives.length ? [alternatives[0]] : [],
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
  const language_code = evt.language_code || language;

  return {
    language_code: language_code,
    channel_tag: channel,
    is_final: evt.is_final,
    alternatives: [evt.alternatives[0]],
    vendor: {
      name: 'google',
      evt: copy
    }
  };
};

const normalizeCobalt = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  const alternatives = (evt.alternatives || [])
    .map((alt) => ({
      confidence: alt.confidence,
      transcript: alt.transcript_formatted,
    }));

  return {
    language_code: language,
    channel_tag: channel,
    is_final: evt.is_final,
    alternatives,
    vendor: {
      name: 'cobalt',
      evt: copy
    }
  };
};

const normalizeCustom = (evt, channel, language, vendor) => {
  const copy = JSON.parse(JSON.stringify(evt));
  return {
    language_code: language,
    channel_tag: channel,
    is_final: evt.is_final,
    alternatives: [evt.alternatives[0]],
    vendor: {
      name: vendor,
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

const normalizeVerbio = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  return {
    language_code: language,
    channel_tag: channel,
    is_final: evt.is_final,
    alternatives: evt.alternatives,
    vendor: {
      name: 'verbio',
      evt: copy
    }
  };
};

const normalizeMicrosoft = (evt, channel, language, punctuation = true) => {
  const copy = JSON.parse(JSON.stringify(evt));
  const nbest = evt.NBest;
  const language_code = evt.PrimaryLanguage?.Language || language;
  const alternatives = nbest ? nbest.map((n) => {
    return {
      confidence: n.Confidence,
      // remove all puntuation if needed
      transcript: punctuation ? n.Display : n.Display.replace(/\p{P}/gu, '')
    };
  }) :
    [
      {
        transcript: punctuation ? evt.DisplayText || evt.Text : (evt.DisplayText || evt.Text).replace(/\p{P}/gu, '')
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

const normalizeAssemblyAi = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  return {
    language_code: language,
    channel_tag: channel,
    is_final: evt.message_type === 'FinalTranscript',
    alternatives: [
      {
        confidence: evt.confidence,
        transcript: evt.text,
      }
    ],
    vendor: {
      name: 'ASSEMBLYAI',
      evt: copy
    }
  };
};

module.exports = (logger) => {
  const normalizeTranscription = (evt, vendor, channel, language, shortUtterance, punctuation) => {

    //logger.debug({ evt, vendor, channel, language }, 'normalizeTranscription');
    switch (vendor) {
      case 'deepgram':
        return normalizeDeepgram(evt, channel, language, shortUtterance);
      case 'microsoft':
        return normalizeMicrosoft(evt, channel, language, punctuation);
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
      case 'soniox':
        return normalizeSoniox(evt, channel, language);
      case 'cobalt':
        return normalizeCobalt(evt, channel, language);
      case 'assemblyai':
        return normalizeAssemblyAi(evt, channel, language, shortUtterance);
      case 'verbio':
        return normalizeVerbio(evt, channel, language);
      default:
        if (vendor.startsWith('custom:')) {
          return normalizeCustom(evt, channel, language, vendor);
        }
        logger.error(`Unknown vendor ${vendor}`);
        return evt;
    }
  };

  const setChannelVarsForStt = (task, sttCredentials, language, rOpts = {}) => {
    let opts = {};
    const vendor = rOpts.vendor;

    if ('google' === vendor) {
      const useV2 = rOpts.googleOptions?.serviceVersion === 'v2';
      const model = task.name === TaskName.Gather ?
        (useV2 ? 'telephony_short' : 'command_and_search') :
        (useV2 ? 'long' : 'latest_long');
      opts = {
        ...opts,
        ...(sttCredentials && {GOOGLE_APPLICATION_CREDENTIALS: JSON.stringify(sttCredentials.credentials)}),
        ...(rOpts.separateRecognitionPerChannel && {GOOGLE_SPEECH_SEPARATE_RECOGNITION_PER_CHANNEL: 1}),
        ...(rOpts.separateRecognitionPerChanne === false && {GOOGLE_SPEECH_SEPARATE_RECOGNITION_PER_CHANNEL: 0}),
        ...(rOpts.profanityFilter && {GOOGLE_SPEECH_PROFANITY_FILTER: 1}),
        ...(rOpts.punctuation && {GOOGLE_SPEECH_ENABLE_AUTOMATIC_PUNCTUATION: 1}),
        ...(rOpts.words && {GOOGLE_SPEECH_ENABLE_WORD_TIME_OFFSETS: 1}),
        ...(rOpts.singleUtterance && {GOOGLE_SPEECH_SINGLE_UTTERANCE: 1}),
        ...(rOpts.diarization && {GOOGLE_SPEECH_SPEAKER_DIARIZATION: 1}),
        ...(rOpts.diarization && rOpts.diarizationMinSpeakers > 0 &&
          {GOOGLE_SPEECH_SPEAKER_DIARIZATION_MIN_SPEAKER_COUNT: rOpts.diarizationMinSpeakers}),
        ...(rOpts.diarization && rOpts.diarizationMaxSpeakers > 0 &&
          {GOOGLE_SPEECH_SPEAKER_DIARIZATION_MAX_SPEAKER_COUNT: rOpts.diarizationMaxSpeakers}),
        ...(rOpts.enhancedModel !== false && {GOOGLE_SPEECH_USE_ENHANCED: 1}),
        ...(rOpts.profanityFilter === false && {GOOGLE_SPEECH_PROFANITY_FILTER: 0}),
        ...(rOpts.punctuation === false && {GOOGLE_SPEECH_ENABLE_AUTOMATIC_PUNCTUATION: 0}),
        ...(rOpts.words  == false && {GOOGLE_SPEECH_ENABLE_WORD_TIME_OFFSETS: 0}),
        ...(rOpts.diarization === false && {GOOGLE_SPEECH_SPEAKER_DIARIZATION: 0}),
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'string' &&
          {GOOGLE_SPEECH_HINTS: rOpts.hints.join(',')}),
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'object' &&
          {GOOGLE_SPEECH_HINTS: JSON.stringify(rOpts.hints)}),
        ...(typeof rOpts.hintsBoost === 'number' && {GOOGLE_SPEECH_HINTS_BOOST: rOpts.hintsBoost}),
        // When altLanguages is emptylist, we have to send value to freeswitch to clear the previous settings
        ...(rOpts.altLanguages &&
          {GOOGLE_SPEECH_ALTERNATIVE_LANGUAGE_CODES: [...new Set(rOpts.altLanguages)].join(',')}),
        ...(rOpts.interactionType &&
          {GOOGLE_SPEECH_METADATA_INTERACTION_TYPE: rOpts.interactionType}),
        ...{GOOGLE_SPEECH_MODEL: rOpts.model || model},
        ...(rOpts.naicsCode > 0 && {GOOGLE_SPEECH_METADATA_INDUSTRY_NAICS_CODE: rOpts.naicsCode}),
        GOOGLE_SPEECH_METADATA_RECORDING_DEVICE_TYPE: 'phone_line',
        ...(useV2 && {
          GOOGLE_SPEECH_RECOGNIZER_PARENT: `projects/${sttCredentials.credentials.project_id}/locations/global`,
          GOOGLE_SPEECH_CLOUD_SERVICES_VERSION: 'v2',
          ...(rOpts.googleOptions?.speechStartTimeoutMs && {
            GOOGLE_SPEECH_START_TIMEOUT_MS: rOpts.googleOptions.speechStartTimeoutMs
          }),
          ...(rOpts.googleOptions?.speechEndTimeoutMs && {
            GOOGLE_SPEECH_END_TIMEOUT_MS: rOpts.googleOptions.speechEndTimeoutMs
          }),
          ...(rOpts.googleOptions?.transcriptNormalization && {
            GOOGLE_SPEECH_TRANSCRIPTION_NORMALIZATION: JSON.stringify(rOpts.googleOptions.transcriptNormalization)
          }),
          ...(rOpts.googleOptions?.enableVoiceActivityEvents && {
            GOOGLE_SPEECH_ENABLE_VOICE_ACTIVITY_EVENTS: rOpts.googleOptions.enableVoiceActivityEvents
          }),
          ...(rOpts.sgoogleOptions?.recognizerId) && {GOOGLE_SPEECH_RECOGNIZER_ID: rOpts.googleOptions.recognizerId},
          ...(rOpts.googleOptions?.enableVoiceActivityEvents && {
            GOOGLE_SPEECH_ENABLE_VOICE_ACTIVITY_EVENTS: rOpts.googleOptions.enableVoiceActivityEvents
          }),
        }),
      };
    }
    else if (['aws', 'polly'].includes(vendor)) {
      opts = {
        ...opts,
        ...(rOpts.vocabularyName && {AWS_VOCABULARY_NAME: rOpts.vocabularyName}),
        ...(rOpts.vocabularyFilterName && {AWS_VOCABULARY_FILTER_NAME: rOpts.vocabularyFilterName}),
        ...(rOpts.filterMethod && {AWS_VOCABULARY_FILTER_METHOD: rOpts.filterMethod}),
        ...(sttCredentials && {
          ...(sttCredentials.accessKeyId && {AWS_ACCESS_KEY_ID: sttCredentials.accessKeyId}),
          ...(sttCredentials.secretAccessKey && {AWS_SECRET_ACCESS_KEY: sttCredentials.secretAccessKey}),
          AWS_REGION: sttCredentials.region,
          ...(sttCredentials.sessionToken && {AWS_SESSION_TOKEN: sttCredentials.sessionToken}),
        }),
      };
    }
    else if ('microsoft' === vendor) {
      const {azureOptions = {}} = rOpts;
      opts = {
        ...opts,
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'string' &&
          {AZURE_SPEECH_HINTS: rOpts.hints.map((h) => h.trim()).join(',')}),
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'object' &&
          {AZURE_SPEECH_HINTS: rOpts.hints.map((h) => h.phrase).join(',')}),
        // When altLanguages is emptylist, we have to send value to freeswitch to clear the previous settings
        ...(rOpts.altLanguages &&
          {AZURE_SPEECH_ALTERNATIVE_LANGUAGE_CODES: [...new Set(rOpts.altLanguages)].join(',')}),
        ...(rOpts.requestSnr && {AZURE_REQUEST_SNR: 1}),
        ...(rOpts.profanityOption && {AZURE_PROFANITY_OPTION: rOpts.profanityOption}),
        ...(sttCredentials.use_custom_stt && sttCredentials.custom_stt_endpoint_url &&
          {AZURE_SERVICE_ENDPOINT: sttCredentials.custom_stt_endpoint_url}),
        ...(rOpts.azureServiceEndpoint && {AZURE_SERVICE_ENDPOINT: rOpts.azureServiceEndpoint}),
        ...(rOpts.initialSpeechTimeoutMs > 0 &&
          {AZURE_INITIAL_SPEECH_TIMEOUT_MS: rOpts.initialSpeechTimeoutMs}),
        ...(rOpts.requestSnr && {AZURE_REQUEST_SNR: 1}),
        ...(rOpts.audioLogging && {AZURE_AUDIO_LOGGING: 1}),
        ...{AZURE_USE_OUTPUT_FORMAT_DETAILED: 1},
        ...(azureOptions.speechSegmentationSilenceTimeoutMs &&
          {AZURE_SPEECH_SEGMENTATION_SILENCE_TIMEOUT_MS: azureOptions.speechSegmentationSilenceTimeoutMs}),
        ...(azureOptions.languageIdMode &&
          {AZURE_LANGUAGE_ID_MODE: azureOptions.languageIdMode}),
        ...(azureOptions.postProcessing &&
          {AZURE_POST_PROCESSING_OPTION: azureOptions.postProcessing}),
        ...(sttCredentials && {
          ...(sttCredentials.api_key && {AZURE_SUBSCRIPTION_KEY: sttCredentials.api_key}),
          ...(sttCredentials.region && {AZURE_REGION: sttCredentials.region}),
        }),
        ...(sttCredentials.use_custom_stt && sttCredentials.custom_stt_endpoint &&
          {AZURE_SERVICE_ENDPOINT_ID: sttCredentials.custom_stt_endpoint}),
        //azureSttEndpointId overrides sttCredentials.custom_stt_endpoint
        ...(rOpts.azureSttEndpointId &&
          {AZURE_SERVICE_ENDPOINT_ID: rOpts.azureSttEndpointId}),
      };
    }
    else if ('nuance' === vendor) {
      /**
       * Note: all nuance options are in recognizer.nuanceOptions, should migrate
       * other vendor settings to similar nested structure
       */
      const {nuanceOptions = {}} = rOpts;
      opts = {
        ...opts,
        ...(sttCredentials.access_token) && {NUANCE_ACCESS_TOKEN: sttCredentials.access_token},
        ...(sttCredentials.nuance_stt_uri) && {NUANCE_KRYPTON_ENDPOINT: sttCredentials.nuance_stt_uri},
        ...(nuanceOptions.topic) && {NUANCE_TOPIC: nuanceOptions.topic},
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
    else if ('deepgram' === vendor) {
      let {model} = rOpts;
      const {deepgramOptions = {}} = rOpts;
      const deepgramUri = deepgramOptions.deepgramSttUri || sttCredentials.deepgram_stt_uri;
      const useTls = deepgramOptions.deepgramSttUseTls || sttCredentials.deepgram_stt_use_tls;

      /* default to a sensible model if not supplied */
      if (!model) {
        model = selectDefaultDeepgramModel(task, language);
      }
      opts = {
        ...opts,
        DEEPGRAM_SPEECH_MODEL: model,
        ...(deepgramUri && {DEEPGRAM_URI: deepgramUri}),
        ...(deepgramUri && useTls && {DEEPGRAM_USE_TLS: 1}),
        ...(sttCredentials.api_key) &&
          {DEEPGRAM_API_KEY: sttCredentials.api_key},
        ...(deepgramOptions.tier) &&
          {DEEPGRAM_SPEECH_TIER: deepgramOptions.tier},
        ...(deepgramOptions.punctuate) &&
          {DEEPGRAM_SPEECH_ENABLE_AUTOMATIC_PUNCTUATION: 1},
        ...(deepgramOptions.smartFormatting) &&
          {DEEPGRAM_SPEECH_ENABLE_SMART_FORMAT: 1},
        ...(deepgramOptions.profanityFilter) &&
          {DEEPGRAM_SPEECH_PROFANITY_FILTER: 1},
        ...(deepgramOptions.redact) &&
          {DEEPGRAM_SPEECH_REDACT: deepgramOptions.redact},
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
        ...(rOpts.hints && rOpts.hints.length > 0 && typeof rOpts.hints[0] === 'string' &&
          {DEEPGRAM_SPEECH_KEYWORDS: rOpts.hints.map((h) => h.trim()).join(',')}),
        ...(rOpts.hints && rOpts.hints.length > 0 && typeof rOpts.hints[0] === 'object' &&
          {DEEPGRAM_SPEECH_KEYWORDS: rOpts.hints.map((h) => h.phrase).join(',')}),
        ...(deepgramOptions.keywords) &&
          {DEEPGRAM_SPEECH_KEYWORDS: deepgramOptions.keywords.join(',')},
        ...('endpointing' in deepgramOptions) &&
          {DEEPGRAM_SPEECH_ENDPOINTING: deepgramOptions.endpointing === false ? 'false' : deepgramOptions.endpointing,
            // default DEEPGRAM_SPEECH_UTTERANCE_END_MS is 1000, will be override by user settings later if there is.
            DEEPGRAM_SPEECH_UTTERANCE_END_MS: 1000},
        ...(deepgramOptions.utteranceEndMs) &&
          {DEEPGRAM_SPEECH_UTTERANCE_END_MS: deepgramOptions.utteranceEndMs},
        ...(deepgramOptions.vadTurnoff) &&
          {DEEPGRAM_SPEECH_VAD_TURNOFF: deepgramOptions.vadTurnoff},
        ...(deepgramOptions.tag) &&
          {DEEPGRAM_SPEECH_TAG: deepgramOptions.tag}
      };
    }
    else if ('soniox' === vendor) {
      const {sonioxOptions = {}} = rOpts;
      const {storage = {}} = sonioxOptions;
      opts = {
        ...opts,
        ...(sttCredentials.api_key) &&
          {SONIOX_API_KEY: sttCredentials.api_key},
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'string' &&
          {SONIOX_HINTS: rOpts.hints.join(',')}),
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'object' &&
          {SONIOX_HINTS: JSON.stringify(rOpts.hints)}),
        ...(typeof rOpts.hintsBoost === 'number' &&
          {SONIOX_HINTS_BOOST: rOpts.hintsBoost}),
        ...(sonioxOptions.model) &&
          {SONIOX_MODEL: sonioxOptions.model},
        ...((sonioxOptions.profanityFilter || rOpts.profanityFilter) && {SONIOX_PROFANITY_FILTER: 1}),
        ...(storage?.id && {SONIOX_STORAGE_ID: storage.id}),
        ...(storage?.id && storage?.title && {SONIOX_STORAGE_TITLE: storage.title}),
        ...(storage?.id && storage?.disableStoreAudio && {SONIOX_STORAGE_DISABLE_AUDIO: 1}),
        ...(storage?.id && storage?.disableStoreTranscript && {SONIOX_STORAGE_DISABLE_TRANSCRIPT: 1}),
        ...(storage?.id && storage?.disableSearch && {SONIOX_STORAGE_DISABLE_SEARCH: 1})
      };
    }
    else if ('ibm' === vendor) {
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
    else if ('nvidia' === vendor) {
      const {nvidiaOptions = {}} = rOpts;
      const rivaUri = nvidiaOptions.rivaUri || sttCredentials.riva_server_uri;
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
        ...(rivaUri && {NVIDIA_RIVA_URI: rivaUri}),
        ...(nvidiaOptions.verbatimTranscripts && {NVIDIA_VERBATIM_TRANSCRIPTS: 1}),
        ...(rOpts.diarization && {NVIDIA_SPEAKER_DIARIZATION: 1}),
        ...(rOpts.diarization && rOpts.diarizationMaxSpeakers > 0 &&
          {NVIDIA_DIARIZATION_SPEAKER_COUNT: rOpts.diarizationMaxSpeakers}),
        ...(rOpts.separateRecognitionPerChannel && {NVIDIA_SEPARATE_RECOGNITION_PER_CHANNEL: 1}),
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'string' &&
          {NVIDIA_HINTS: rOpts.hints.join(',')}),
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'object' &&
          {NVIDIA_HINTS: JSON.stringify(rOpts.hints)}),
        ...(typeof rOpts.hintsBoost === 'number' &&
          {NVIDIA_HINTS_BOOST: rOpts.hintsBoost}),
        ...(nvidiaOptions.customConfiguration &&
          {NVIDIA_CUSTOM_CONFIGURATION: JSON.stringify(nvidiaOptions.customConfiguration)}),
      };
    }
    else if ('cobalt' === vendor) {
      const {cobaltOptions = {}} = rOpts;
      const cobaltUri = cobaltOptions.serverUri || sttCredentials.cobalt_server_uri;
      opts = {
        ...opts,
        ...(rOpts.words && {COBALT_WORD_TIME_OFFSETS: 1}),
        ...(!rOpts.words && {COBALT_WORD_TIME_OFFSETS: 0}),
        ...(rOpts.model && {COBALT_MODEL: rOpts.model}),
        ...(cobaltUri && {COBALT_SERVER_URI: cobaltUri}),
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'string' &&
          {COBALT_SPEECH_HINTS: rOpts.hints.join(',')}),
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'object' &&
          {COBALT_SPEECH_HINTS: JSON.stringify(rOpts.hints)}),
        ...(rOpts.hints?.length > 0 &&
          {COBALT_CONTEXT_TOKEN: cobaltOptions.contextToken || 'unk:default'}),
        ...(cobaltOptions.metadata && {COBALT_METADATA: cobaltOptions.metadata}),
        ...(cobaltOptions.enableConfusionNetwork && {COBALT_ENABLE_CONFUSION_NETWORK: 1}),
        ...(cobaltOptions.compiledContextData && {COBALT_COMPILED_CONTEXT_DATA: cobaltOptions.compiledContextData}),
      };
    } else if ('assemblyai' === vendor) {
      opts = {
        ...opts,
        ...(sttCredentials.api_key) &&
          {ASSEMBLYAI_API_KEY: sttCredentials.api_key},
        ...(rOpts.hints?.length > 0 &&
          {ASSEMBLYAI_WORD_BOOST: JSON.stringify(rOpts.hints)})
      };
    } else if ('verbio' === vendor) {
      const {verbioOptions = {}} = rOpts;
      opts = {
        ...opts,
        ...(sttCredentials.access_token && { VERBIO_ACCESS_TOKEN: sttCredentials.access_token}),
        ...(sttCredentials.engine_version && {VERBIO_ENGINE_VERSION: sttCredentials.engine_version}),
        ...(language && {VERBIO_LANGUAGE: language}),
        ...(verbioOptions.enable_formatting && {VERBIO_ENABLE_FORMATTING: verbioOptions.enable_formatting}),
        ...(verbioOptions.enable_diarization && {VERBIO_ENABLE_DIARIZATION: verbioOptions.enable_diarization}),
        ...(verbioOptions.topic && {VERBIO_TOPIC: verbioOptions.topic}),
        ...(verbioOptions.inline_grammar && {VERBIO_INLINE_GRAMMAR: verbioOptions.inline_grammar}),
        ...(verbioOptions.grammar_uri && {VERBIO_GRAMMAR_URI: verbioOptions.grammar_uri}),
        ...(verbioOptions.label && {VERBIO_LABEL: verbioOptions.label}),
        ...(verbioOptions.recognition_timeout && {VERBIO_RECOGNITION_TIMEOUT: verbioOptions.recognition_timeout}),
        ...(verbioOptions.speech_complete_timeout &&
          {VERBIO_SPEECH_COMPLETE_TIMEOUT: verbioOptions.speech_complete_timeout}),
        ...(verbioOptions.speech_incomplete_timeout &&
          {VERBIO_SPEECH_INCOMPLETE_TIMEOUT: verbioOptions.speech_incomplete_timeout}),
      };
    } else if (vendor.startsWith('custom:')) {
      let {options = {}} = rOpts;
      const {sampleRate} = rOpts.customOptions || {};
      const {auth_token, custom_stt_url} = sttCredentials;
      options = {
        ...options,
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'string' &&
        {hints: rOpts.hints}),
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'object' &&
        {hints: JSON.stringify(rOpts.hints)}),
        ...(typeof rOpts.hintsBoost === 'number' && {hintsBoost: rOpts.hintsBoost})
      };
      opts = {
        ...opts,
        ...(auth_token && {JAMBONZ_STT_API_KEY: auth_token}),
        JAMBONZ_STT_URL: custom_stt_url,
        ...(Object.keys(options).length > 0 && {JAMBONZ_STT_OPTIONS: JSON.stringify(options)}),
        ...(sampleRate && {JAMBONZ_STT_SAMPLING: sampleRate})
      };
    }

    (stickyVars[vendor] || []).forEach((key) => {
      if (!opts[key]) opts[key] = '';
    });
    return opts;
  };

  const setSpeechCredentialsAtRuntime = (recognizer) => {
    if (!recognizer) return;
    if (recognizer.vendor === 'nuance') {
      const {clientId, secret, kryptonEndpoint} = recognizer.nuanceOptions || {};
      if (clientId && secret) return {client_id: clientId, secret};
      if (kryptonEndpoint) return {nuance_stt_uri: kryptonEndpoint};
    }
    else if (recognizer.vendor === 'nvidia') {
      const {rivaUri} = recognizer.nvidiaOptions || {};
      if (rivaUri) return {riva_uri: rivaUri};
    }
    else if (recognizer.vendor === 'deepgram') {
      const {apiKey} = recognizer.deepgramOptions || {};
      if (apiKey) return {api_key: apiKey};
    }
    else if (recognizer.vendor === 'soniox') {
      const {apiKey} = recognizer.sonioxOptions || {};
      if (apiKey) return {api_key: apiKey};
    }
    else if (recognizer.vendor === 'cobalt') {
      const {serverUri} = recognizer.cobaltOptions || {};
      if (serverUri) return {cobalt_server_uri: serverUri};
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
    setSpeechCredentialsAtRuntime,
    compileSonioxTranscripts,
    consolidateTranscripts
  };
};
