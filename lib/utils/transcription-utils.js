const {TaskName} = require('./constants.json');
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
    'DEEPGRAM_SPEECH_ENABLE_NO_DELAY',
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
    'DEEPGRAM_SPEECH_TAG',
    'DEEPGRAM_SPEECH_MODEL_VERSION',
    'DEEPGRAM_SPEECH_FILLER_WORDS',
    'DEEPGRAM_SPEECH_KEYTERMS',
  ],
  aws: [
    'AWS_VOCABULARY_NAME',
    'AWS_VOCABULARY_FILTER_METHOD',
    'AWS_VOCABULARY_FILTER_NAME',
    'AWS_LANGUAGE_MODEL_NAME',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_REGION',
    'AWS_SECURITY_TOKEN',
    'AWS_PII_ENTITY_TYPES',
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
  ],
  voxist: [
    'VOXIST_API_KEY',
  ],
  cartesia: [
    'CARTESIA_API_KEY',
    'CARTESIA_MODEL_ID'
  ],
  speechmatics: [
    'SPEECHMATICS_API_KEY',
    'SPEECHMATICS_HOST',
    'SPEECHMATICS_PATH',
    'SPEECHMATICS_SPEECH_HINTS',
    'SPEECHMATICS_TRANSLATION_LANGUAGES',
    'SPEECHMATICS_TRANSLATION_PARTIALS'
  ],
  openai: [
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'OPENAI_INPUT_AUDIO_NOISE_REDUCTION',
    'OPENAI_TURN_DETECTION_TYPE',
    'OPENAI_TURN_DETECTION_THRESHOLD',
    'OPENAI_TURN_DETECTION_PREFIX_PADDING_MS',
    'OPENAI_TURN_DETECTION_SILENCE_DURATION_MS',
  ],
  houndify: [
    'HOUNDIFY_CLIENT_ID',
    'HOUNDIFY_CLIENT_KEY',
    'HOUNDIFY_USER_ID',
    'HOUNDIFY_MAX_SILENCE_SECONDS',
    'HOUNDIFY_MAX_SILENCE_AFTER_FULL_QUERY_SECONDS',
    'HOUNDIFY_MAX_SILENCE_AFTER_PARTIAL_QUERY_SECONDS',
    'HOUNDIFY_VAD_SENSITIVITY',
    'HOUNDIFY_VAD_TIMEOUT',
    'HOUNDIFY_VAD_MODE',
    'HOUNDIFY_VAD_VOICE_MS',
    'HOUNDIFY_VAD_SILENCE_MS',
    'HOUNDIFY_VAD_DEBUG',
    'HOUNDIFY_AUDIO_FORMAT',
    'HOUNDIFY_ENABLE_NOISE_REDUCTION',
    'HOUNDIFY_AUDIO_ENDPOINT',
    'HOUNDIFY_ENABLE_PROFANITY_FILTER',
    'HOUNDIFY_ENABLE_PUNCTUATION',
    'HOUNDIFY_ENABLE_CAPITALIZATION',
    'HOUNDIFY_CONFIDENCE_THRESHOLD',
    'HOUNDIFY_ENABLE_DISFLUENCY_FILTER',
    'HOUNDIFY_MAX_RESULTS',
    'HOUNDIFY_ENABLE_WORD_TIMESTAMPS',
    'HOUNDIFY_MAX_ALTERNATIVES',
    'HOUNDIFY_PARTIAL_TRANSCRIPT_INTERVAL',
    'HOUNDIFY_SESSION_TIMEOUT',
    'HOUNDIFY_CONNECTION_TIMEOUT',
    'HOUNDIFY_LATITUDE',
    'HOUNDIFY_LONGITUDE',
    'HOUNDIFY_CITY',
    'HOUNDIFY_STATE',
    'HOUNDIFY_COUNTRY',
    'HOUNDIFY_TIMEZONE',
    'HOUNDIFY_DOMAIN',
    'HOUNDIFY_CUSTOM_VOCABULARY',
    'HOUNDIFY_LANGUAGE_MODEL'
  ],
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

const optimalGoogleModels = {
  'v1' : {
    'en-IN':['telephony', 'telephony'],
    'es-DO':['default', 'default'],
    'es-MX':['default', 'default'],
    'en-AU':['telephony', 'telephony'],
    'en-GB':['telephony', 'telephony'],
    'en-NZ':['telephony', 'telephony']
  },
  'v2' : {
    'en-IN':['telephony', 'long']
  }
};
const selectDefaultGoogleModel = (task, language, version) => {
  const useV2 = version === 'v2';
  if (language in optimalGoogleModels[version]) {
    const [gather, transcribe] = optimalGoogleModels[version][language];
    return task.name === TaskName.Gather ? gather : transcribe;
  }
  return task.name === TaskName.Gather ?
    (useV2 ? 'telephony_short' : 'command_and_search') :
    (useV2 ? 'long' : 'latest_long');
};
const consolidateTranscripts = (bufferedTranscripts, channel, language, vendor) => {
  if (bufferedTranscripts.length === 1) {
    bufferedTranscripts[0].is_final = true;
    return bufferedTranscripts[0];
  }
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

    if (vendor === 'speechmatics' || (lastChar.match(/\d/) && firstChar.match(/\d/))) {
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
   * Some models (nova-2-general) return the detected language in the
   * alternatives.languages array if the language is set as multi.
   * If the language is detected, we use it as the language_code.
   */
  const detectedLanguage = evt.channel?.alternatives?.[0]?.languages?.[0];
  /**
   * note difference between is_final and speech_final in Deepgram:
   * https://developers.deepgram.com/docs/understand-endpointing-interim-results
   */
  return {
    language_code: detectedLanguage || language,
    channel_tag: channel,
    is_final: shortUtterance ? evt.is_final : evt.speech_final,
    alternatives: alternatives.length ? [alternatives[0]] : [],
    vendor: {
      name: 'deepgram',
      evt: copy
    }
  };
};

const normalizeGladia = (evt, channel, language, shortUtterance) => {
  const copy = JSON.parse(JSON.stringify(evt));

  // Handle Gladia transcript format
  if (evt.type === 'transcript' && evt.data && evt.data.utterance) {
    const utterance = evt.data.utterance;
    const alternatives = [{
      confidence: utterance.confidence || 0,
      transcript: utterance.text || '',
    }];

    return {
      language_code: utterance.language || language,
      channel_tag: channel,
      is_final: evt.data.is_final || false,
      alternatives,
      vendor: {
        name: 'gladia',
        evt: copy
      }
    };
  }
};

const normalizeDeepgramFlux = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));

  let turnTakingEvent;
  if (['StartOfTurn', 'EagerEndOfTurn', 'TurnResumed', 'EndOfTurn'].includes(evt.event)) {
    turnTakingEvent = evt.event;
  }

  /* calculate total confidence based on word-level confidence */
  const realWords = (evt.words || [])
    .filter((w) => ![',.!?;'].includes(w.word));
  const confidence = realWords.length > 0 ? realWords.reduce((acc, w) => acc + w.confidence, 0) / realWords.length : 0;
  return {
    language_code: language,
    channel_tag: channel,
    is_final: evt.event === 'EndOfTurn',
    alternatives: [
      {
        confidence,
        end_of_turn_confidence: evt.end_of_turn_confidence,
        transcript: evt.transcript,
        ...(turnTakingEvent && {turn_taking_event: turnTakingEvent})
      }
    ],
    vendor: {
      name: 'deepgramflux',
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
  const isGrpcPayload = Array.isArray(evt);
  if (isGrpcPayload) {
    /* legacy grpc api */
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
  }
  else {
    /* websocket api */
    const alternatives = evt.Transcript?.Results[0]?.Alternatives.map((alt) => {
      const items = alt.Items.filter((item) => item.Type === 'pronunciation' && 'Confidence' in item);
      const confidence = items.reduce((acc, item) => acc + item.Confidence, 0) / items.length;
      return {
        transcript: alt.Transcript,
        confidence
      };
    });
    return {
      language_code: language,
      channel_tag: channel,
      is_final: evt.Transcript?.Results[0].IsPartial === false,
      alternatives,
      vendor: {
        name: 'aws',
        evt: copy
      }
    };
  }
};

const normalizeAssemblyAi = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  const alternatives = [];
  let is_final = false;
  if (evt.type && evt.type === 'Turn') {
    // v3 is here
    alternatives.push({
      confidence: evt.end_of_turn_confidence,
      transcript: evt.transcript,
    });
    is_final = evt.end_of_turn;
  } else {
    alternatives.push({
      confidence: evt.confidence,
      transcript: evt.text,
    });
    is_final = evt.message_type === 'FinalTranscript';
  }
  return {
    language_code: language,
    channel_tag: channel,
    is_final,
    alternatives,
    vendor: {
      name: 'assemblyai',
      evt: copy
    }
  };
};

const normalizeHoundify = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  const alternatives = [];
  const is_final = evt.ResultsAreFinal && evt.ResultsAreFinal[0] === true;
  if (evt.Disambiguation && evt.Disambiguation.ChoiceData && evt.Disambiguation.ChoiceData.length > 0) {
    // Handle Houndify Voice Search Result format
    const choiceData = evt.Disambiguation.ChoiceData[0];
    alternatives.push({
      confidence: choiceData.ConfidenceScore || choiceData.ASRConfidence || 0.0,
      transcript: choiceData.FormattedTranscription || choiceData.Transcription || '',
    });
  }
  return {
    language_code: language,
    channel_tag: channel,
    is_final,
    alternatives,
    vendor: {
      name: 'houndify',
      evt: copy
    }
  };
};

const normalizeVoxist = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  return {
    language_code: language,
    channel_tag: channel,
    is_final: evt.type === 'final',
    alternatives: [
      {
        confidence: 1.00,
        transcript: evt.text,
      }
    ],
    vendor: {
      name: 'voxist',
      evt: copy
    }
  };
};

const normalizeCartesia = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  return {
    language_code: language,
    channel_tag: channel,
    is_final: evt.is_final,
    alternatives: [
      {
        confidence: 1.00,
        transcript: evt.text,
      }
    ],
    vendor: {
      name: 'cartesia',
      evt: copy
    }
  };
};

const normalizeSpeechmatics = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  const is_final = evt.message === 'AddTranscript';
  const words = evt.results?.filter((r) => r.type === 'word') || [];
  const confidence = words.length > 0 ?
    words.reduce((acc, word) => acc + word.alternatives[0].confidence, 0) / words.length :
    0;

  const alternative = {
    confidence,
    transcript: evt.metadata?.transcript
  };
  const obj = {
    language_code: language,
    channel_tag: channel,
    is_final,
    alternatives: [alternative],
    vendor: {
      name: 'speechmatics',
      evt: copy
    }
  };
  return obj;
};

const calculateConfidence = (logprobsArray) => {
  // Sum the individual log probabilities
  const totalLogProb = logprobsArray.reduce((sum, tokenInfo) => sum + tokenInfo.logprob, 0);

  // Convert the total log probability back to a regular probability
  const confidence = Math.exp(totalLogProb);
  return confidence;
};

const normalizeOpenAI = (evt, channel, language) => {
  const copy = JSON.parse(JSON.stringify(evt));
  const obj = {
    language_code: language,
    channel_tag: channel,
    is_final: true,
    alternatives: [
      {
        transcript: evt.transcript,
        confidence: evt.logprobs ? calculateConfidence(evt.logprobs) : 1.0,
      }
    ],
    vendor: {
      name: 'openai',
      evt: copy
    }
  };
  return obj;
};

module.exports = (logger) => {
  const normalizeTranscription = (evt, vendor, channel, language, shortUtterance, punctuation) => {

    //logger.debug({ evt, vendor, channel, language }, 'normalizeTranscription');
    switch (vendor) {
      case 'deepgram':
        return normalizeDeepgram(evt, channel, language, shortUtterance);
      case 'gladia':
        return normalizeGladia(evt, channel, language, shortUtterance);
      case 'deepgramflux':
        return normalizeDeepgramFlux(evt, channel, language, shortUtterance);
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
      case 'houndify':
        return normalizeHoundify(evt, channel, language, shortUtterance);
      case 'voxist':
        return normalizeVoxist(evt, channel, language);
      case 'cartesia':
        return normalizeCartesia(evt, channel, language);
      case 'verbio':
        return normalizeVerbio(evt, channel, language);
      case 'speechmatics':
        return normalizeSpeechmatics(evt, channel, language);
      case 'openai':
        return normalizeOpenAI(evt, channel, language);
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
      const version = useV2 ? 'v2' : 'v1';
      let {model} = rOpts;
      model = model || selectDefaultGoogleModel(task, language, version);
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
      const {awsOptions = {}} = rOpts;
      const vocabularyName = awsOptions.vocabularyName || rOpts.vocabularyName;
      const vocabularyFilterName = awsOptions.vocabularyFilterName || rOpts.vocabularyFilterName;
      const filterMethod = awsOptions.vocabularyFilterMethod || rOpts.filterMethod;
      opts = {
        ...opts,
        ...(vocabularyName && {AWS_VOCABULARY_NAME: vocabularyName}),
        ...(vocabularyFilterName && {AWS_VOCABULARY_FILTER_NAME: vocabularyFilterName}),
        ...(filterMethod && {AWS_VOCABULARY_FILTER_METHOD: filterMethod}),
        ...(sttCredentials && {
          AWS_ACCESS_KEY_ID: sttCredentials.accessKeyId,
          AWS_SECRET_ACCESS_KEY: sttCredentials.secretAccessKey,
          AWS_REGION: sttCredentials.region,
          AWS_SECURITY_TOKEN: sttCredentials.securityToken,
          AWS_SESSION_TOKEN: sttCredentials.sessionToken ? sttCredentials.sessionToken : sttCredentials.securityToken
        }),
        ...(awsOptions.accessKey && {AWS_ACCESS_KEY_ID: awsOptions.accessKey}),
        ...(awsOptions.secretKey && {AWS_SECRET_ACCESS_KEY: awsOptions.secretKey}),
        ...(awsOptions.region && {AWS_REGION: awsOptions.region}),
        ...(awsOptions.securityToken && {AWS_SECURITY_TOKEN: awsOptions.securityToken}),
        ...(awsOptions.sessionToken && {AWS_SESSION_TOKEN: awsOptions.sessionToken ?
          awsOptions.sessionToken : awsOptions.securityToken}),
        ...(awsOptions.languageModelName && {AWS_LANGUAGE_MODEL_NAME: awsOptions.languageModelName}),
        ...(awsOptions.piiEntityTypes?.length && {AWS_PII_ENTITY_TYPES: awsOptions.piiEntityTypes.join(',')}),
        ...(awsOptions.piiIdentifyEntities && {AWS_PII_IDENTIFY_ENTITIES: true}),
        ...(awsOptions.languageModelName && {AWS_LANGUAGE_MODEL_NAME: awsOptions.languageModelName}),
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
        ...(azureOptions.audioLogging && {AZURE_AUDIO_LOGGING: 1}),
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
        ...(azureOptions.speechRecognitionMode &&
          {AZURE_RECOGNITION_MODE: azureOptions.speechRecognitionMode}),
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
      let model = rOpts.deepgramOptions?.model || rOpts.model || sttCredentials.model_id;
      const {deepgramOptions = {}} = rOpts;
      const deepgramUri = deepgramOptions.deepgramSttUri || sttCredentials.deepgram_stt_uri;
      const useTls = deepgramOptions.deepgramSttUseTls || sttCredentials.deepgram_stt_use_tls;

      // DH (2025-08-11) entity_prompt is currently limited to 100 words
      const entityPrompt = deepgramOptions.entityPrompt ?
        deepgramOptions.entityPrompt
          .split(/\s+/)
          .slice(0, 100)
          .join(' ')
        : undefined;

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
        ...(deepgramOptions.noDelay) &&
          {DEEPGRAM_SPEECH_ENABLE_NO_DELAY: 1},
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
          {DEEPGRAM_SPEECH_TAG: deepgramOptions.tag},
        ...(deepgramOptions.version) &&
          {DEEPGRAM_SPEECH_MODEL_VERSION: deepgramOptions.version},
        ...(deepgramOptions.fillerWords) &&
          {DEEPGRAM_SPEECH_FILLER_WORDS: deepgramOptions.fillerWords},
        ...((Array.isArray(deepgramOptions.keyterms) && deepgramOptions.keyterms.length > 0) &&
          {DEEPGRAM_SPEECH_KEYTERMS: deepgramOptions.keyterms.join(',')}),
        ...(deepgramOptions.mipOptOut && {DEEPGRAM_SPEECH_MIP_OPT_OUT: deepgramOptions.mipOptOut}),
        ...(entityPrompt && {DEEPGRAM_SPEECH_ENTITY_PROMPT: entityPrompt}),
      };
    }
    else if ('deepgramflux' === vendor) {
      const {
        eotThreshold,
        eotTimeoutMs,
        mipOptOut,
        model,
        eagerEotThreshold,
        keyterms
      } = rOpts.deepgramOptions || {};
      opts = {
        DEEPGRAMFLUX_API_KEY: sttCredentials.api_key,
        DEEPGRAMFLUX_SPEECH_MODEL: model || 'flux-general-en',
        ...(eotThreshold && {DEEPGRAMFLUX_SPEECH_EOT_THRESHOLD: eotThreshold}),
        ...(eotTimeoutMs && {DEEPGRAMFLUX_SPEECH_EOT_TIMEOUT_MS: eotTimeoutMs}),
        ...(mipOptOut && {DEEPGRAMFLUX_SPEECH_MIP_OPT_OUT: mipOptOut}),
        ...(eagerEotThreshold && {DEEPGRAMFLUX_SPEECH_EAGER_EOT_THRESHOLD: eagerEotThreshold}),
        ...(keyterms && keyterms.length > 0 && {DEEPGRAMFLUX_SPEECH_KEYTERMS: keyterms.join(',')}),
      };
    }
    else if ('gladia' === vendor) {
      const {host, path} = sttCredentials;
      opts = {
        GLADIA_SPEECH_HOST: host,
        GLADIA_SPEECH_PATH: path,
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
    }
    else if ('assemblyai' === vendor) {
      const serviceVersion = rOpts.assemblyAiOptions?.serviceVersion || sttCredentials.service_version || 'v2';
      const {
        formatTurns,
        endOfTurnConfidenceThreshold,
        minEndOfTurnSilenceWhenConfident,
        maxTurnSilence
      } = rOpts.assemblyAiOptions || {};
      opts = {
        ...opts,
        ASSEMBLYAI_API_VERSION: serviceVersion,
        ...(serviceVersion === 'v3' && {
          ...(formatTurns && {
            ASSEMBLYAI_FORMAT_TURNS: formatTurns
          }),
          ...(endOfTurnConfidenceThreshold && {
            ASSEMBLYAI_END_OF_TURN_CONFIDENCE_THRESHOLD: endOfTurnConfidenceThreshold
          }),
          ASSEMBLYAI_MIN_END_OF_TURN_SILENCE_WHEN_CONFIDENT: minEndOfTurnSilenceWhenConfident || 500,
          ...(maxTurnSilence && {
            ASSEMBLYAI_MAX_TURN_SILENCE: maxTurnSilence
          }),
        }),
        ...(sttCredentials.api_key) &&
          {ASSEMBLYAI_API_KEY: sttCredentials.api_key},
        ...(rOpts.hints?.length > 0 &&
          {ASSEMBLYAI_WORD_BOOST: JSON.stringify(rOpts.hints)})
      };
    }
    else if ('houndify' === vendor) {
      const {
        latitude, longitude, city, state, country, timeZone, domain, audioEndpoint,
        maxSilenceSeconds, maxSilenceAfterFullQuerySeconds, maxSilenceAfterPartialQuerySeconds,
        vadSensitivity, vadTimeout, vadMode, vadVoiceMs, vadSilenceMs, vadDebug,
        audioFormat, enableNoiseReduction, enableProfanityFilter, enablePunctuation,
        enableCapitalization, confidenceThreshold, enableDisfluencyFilter,
        maxResults, enableWordTimestamps, maxAlternatives, partialTranscriptInterval,
        sessionTimeout, connectionTimeout, customVocabulary, languageModel
      } = rOpts.houndifyOptions || {};

      opts = {
        ...opts,
        HOUNDIFY_CLIENT_ID: sttCredentials.client_id,
        HOUNDIFY_CLIENT_KEY: sttCredentials.client_key,
        HOUNDIFY_USER_ID: sttCredentials.user_id,
        HOUNDIFY_MAX_SILENCE_SECONDS: maxSilenceSeconds || 5,
        HOUNDIFY_MAX_SILENCE_AFTER_FULL_QUERY_SECONDS: maxSilenceAfterFullQuerySeconds || 1,
        HOUNDIFY_MAX_SILENCE_AFTER_PARTIAL_QUERY_SECONDS: maxSilenceAfterPartialQuerySeconds || 1.5,
        ...(vadSensitivity && {HOUNDIFY_VAD_SENSITIVITY: vadSensitivity}),
        ...(vadTimeout && {HOUNDIFY_VAD_TIMEOUT: vadTimeout}),
        ...(vadMode && {HOUNDIFY_VAD_MODE: vadMode}),
        ...(vadVoiceMs && {HOUNDIFY_VAD_VOICE_MS: vadVoiceMs}),
        ...(vadSilenceMs && {HOUNDIFY_VAD_SILENCE_MS: vadSilenceMs}),
        ...(vadDebug && {HOUNDIFY_VAD_DEBUG: vadDebug}),
        ...(audioFormat && {HOUNDIFY_AUDIO_FORMAT: audioFormat}),
        ...(enableNoiseReduction && {HOUNDIFY_ENABLE_NOISE_REDUCTION: enableNoiseReduction}),
        ...(enableProfanityFilter && {HOUNDIFY_ENABLE_PROFANITY_FILTER: enableProfanityFilter}),
        ...(enablePunctuation && {HOUNDIFY_ENABLE_PUNCTUATION: enablePunctuation}),
        ...(enableCapitalization && {HOUNDIFY_ENABLE_CAPITALIZATION: enableCapitalization}),
        ...(confidenceThreshold && {HOUNDIFY_CONFIDENCE_THRESHOLD: confidenceThreshold}),
        ...(enableDisfluencyFilter && {HOUNDIFY_ENABLE_DISFLUENCY_FILTER: enableDisfluencyFilter}),
        ...(maxResults && {HOUNDIFY_MAX_RESULTS: maxResults}),
        ...(enableWordTimestamps && {HOUNDIFY_ENABLE_WORD_TIMESTAMPS: enableWordTimestamps}),
        ...(maxAlternatives && {HOUNDIFY_MAX_ALTERNATIVES: maxAlternatives}),
        ...(partialTranscriptInterval && {HOUNDIFY_PARTIAL_TRANSCRIPT_INTERVAL: partialTranscriptInterval}),
        ...(sessionTimeout && {HOUNDIFY_SESSION_TIMEOUT: sessionTimeout}),
        ...(connectionTimeout && {HOUNDIFY_CONNECTION_TIMEOUT: connectionTimeout}),
        ...(latitude && {HOUNDIFY_LATITUDE: latitude}),
        ...(longitude && {HOUNDIFY_LONGITUDE: longitude}),
        ...(city && {HOUNDIFY_CITY: city}),
        ...(state && {HOUNDIFY_STATE: state}),
        ...(country && {HOUNDIFY_COUNTRY: country}),
        ...(timeZone && {HOUNDIFY_TIMEZONE: timeZone}),
        ...(domain && {HOUNDIFY_DOMAIN: domain}),
        ...(audioEndpoint && {HOUNDIFY_AUDIO_ENDPOINT: audioEndpoint}),
        ...(customVocabulary && {HOUNDIFY_CUSTOM_VOCABULARY:
          Array.isArray(customVocabulary) ? customVocabulary.join(',') : customVocabulary}),
        ...(languageModel && {HOUNDIFY_LANGUAGE_MODEL: languageModel}),
      };
    }
    else if ('voxist' === vendor) {
      opts = {
        ...opts,
        ...(sttCredentials.api_key) &&
          {VOXIST_API_KEY: sttCredentials.api_key},
      };
    }
    else if ('cartesia' === vendor) {
      opts = {
        ...opts,
        ...(sttCredentials.api_key &&
          {CARTESIA_API_KEY: sttCredentials.api_key}),
        ...(sttCredentials.stt_model_id && {
          CARTESIA_MODEL_ID: sttCredentials.stt_model_id
        })
      };
    }
    else if ('openai' === vendor) {
      const {openaiOptions = {}} = rOpts;
      const model = openaiOptions.model || rOpts.model || sttCredentials.model_id || 'whisper-1';
      const apiKey = openaiOptions.apiKey || sttCredentials.api_key;

      opts = {
        OPENAI_MODEL: model,
        OPENAI_API_KEY: apiKey,
        ...opts,
        ...(openaiOptions.prompt && {OPENAI_PROMPT: openaiOptions.prompt}),
        ...(openaiOptions.input_audio_noise_reduction &&
          {OPENAI_INPUT_AUDIO_NOISE_REDUCTION: openaiOptions.input_audio_noise_reduction}),
      };

      if (openaiOptions.turn_detection) {
        opts = {
          ...opts,
          OPENAI_TURN_DETECTION_TYPE: openaiOptions.turn_detection.type,
          ...(openaiOptions.turn_detection.threshold && {
            OPENAI_TURN_DETECTION_THRESHOLD: openaiOptions.turn_detection.threshold
          }),
          ...(openaiOptions.turn_detection.prefix_padding_ms && {
            OPENAI_TURN_DETECTION_PREFIX_PADDING_MS: openaiOptions.turn_detection.prefix_padding_ms
          }),
          ...(openaiOptions.turn_detection.silence_duration_ms && {
            OPENAI_TURN_DETECTION_SILENCE_DURATION_MS: openaiOptions.turn_detection.silence_duration_ms
          }),
        };
      }
    }
    else if ('verbio' === vendor) {
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
    }
    else if ('speechmatics' === vendor) {
      const {speechmaticsOptions = {}} = rOpts;
      opts = {
        ...opts,
        ...(sttCredentials.api_key) && {SPEECHMATICS_API_KEY: sttCredentials.api_key},
        ...(sttCredentials.speechmatics_stt_uri) && {SPEECHMATICS_HOST: sttCredentials.speechmatics_stt_uri},
        ...(rOpts.hints?.length > 0 && {SPEECHMATICS_SPEECH_HINTS: rOpts.hints.join(',')}),
        ...(speechmaticsOptions.translation_config &&
          {
            SPEECHMATICS_TRANSLATION_LANGUAGES: speechmaticsOptions.translation_config.target_languages.join(','),
            SPEECHMATICS_TRANSLATION_PARTIALS: speechmaticsOptions.translation_config.enable_partials ? 1 : 0
          }
        ),
        ...(speechmaticsOptions.transcription_config?.domain &&
          {SPEECHMATICS_DOMAIN: speechmaticsOptions.transcription_config.domain}),
        ...{SPEECHMATICS_MAX_DELAY: speechmaticsOptions.transcription_config?.max_delay || 0.7},
        ...{SPEECHMATICS_MAX_DELAY_MODE: speechmaticsOptions.transcription_config?.max_delay_mode || 'flexible'},
        ...(speechmaticsOptions.transcription_config?.diarization &&
            {SPEECHMATICS_DIARIZATION: speechmaticsOptions.transcription_config.diarization}),
        ...(speechmaticsOptions.transcription_config?.speaker_diarization_config?.speaker_sensitivity &&
          {SPEECHMATICS_DIARIZATION_SPEAKER_SENSITIVITY:
            speechmaticsOptions.transcription_config.speaker_diarization_config.speaker_sensitivity}),
        ...(speechmaticsOptions.transcription_config?.speaker_diarization_config?.max_speakers &&
          {SPEECHMATICS_DIARIZATION_MAX_SPEAKERS:
            speechmaticsOptions.transcription_config.speaker_diarization_config.max_speakers}),
        ...(speechmaticsOptions.transcription_config?.output_locale &&
          {SPEECHMATICS_OUTPUT_LOCALE: speechmaticsOptions.transcription_config.output_locale}),
        ...(speechmaticsOptions.transcription_config?.punctuation_overrides?.permitted_marks &&
          {SPEECHMATICS_PUNCTUATION_ALLOWED:
            speechmaticsOptions.transcription_config.punctuation_overrides.permitted_marks.join(',')}),
        ...(speechmaticsOptions.transcription_config?.punctuation_overrides?.sensitivity &&
          {SPEECHMATICS_PUNCTUATION_SENSITIVITY:
            speechmaticsOptions.transcription_config?.punctuation_overrides?.sensitivity}),
        ...(speechmaticsOptions.transcription_config?.operating_point &&
          {SPEECHMATICS_OPERATING_POINT: speechmaticsOptions.transcription_config.operating_point}),
        ...(speechmaticsOptions.transcription_config?.enable_entities &&
          {SPEECHMATICS_ENABLE_ENTTIES: speechmaticsOptions.transcription_config.enable_entities}),
        ...(speechmaticsOptions.transcription_config?.audio_filtering_config?.volume_threshold &&
          {SPEECHMATICS_VOLUME_THRESHOLD:
            speechmaticsOptions.transcription_config.audio_filtering_config.volume_threshold}),
        ...(speechmaticsOptions.transcription_config?.transcript_filtering_config?.remove_disfluencies &&
          {SPEECHMATICS_REMOVE_DISFLUENCIES:
            speechmaticsOptions.transcription_config.transcript_filtering_config.remove_disfluencies})
      };
    }
    else if (vendor.startsWith('custom:')) {
      let {options = {}} = rOpts.customOptions || {};
      const {sampleRate} = rOpts.customOptions || {};
      const {auth_token, custom_stt_url} = sttCredentials;
      options = {
        ...options,
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'string' &&
        {hints: rOpts.hints}),
        ...(rOpts.hints?.length > 0 && typeof rOpts.hints[0] === 'object' &&
        {hints: JSON.stringify(rOpts.hints)}),
        ...(typeof rOpts.hintsBoost === 'number' && {hintsBoost: rOpts.hintsBoost}),
        ...(task.cs?.callSid && {callSid: task.cs.callSid})
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
    consolidateTranscripts,
  };
};
