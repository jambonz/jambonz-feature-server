const Emitter = require('events');
const {readFile} = require('fs');
const {
  TaskName,
  GoogleTranscriptionEvents,
  AwsTranscriptionEvents,
  AzureTranscriptionEvents,
  NuanceTranscriptionEvents,
  NvidiaTranscriptionEvents,
  IbmTranscriptionEvents,
  SonioxTranscriptionEvents,
  CobaltTranscriptionEvents,
  DeepgramTranscriptionEvents,
  JambonzTranscriptionEvents,
  AmdEvents,
  AvmdEvents
} = require('./constants');
const bugname = 'amd_bug';
const {VMD_HINTS_FILE} = require('../config');
let voicemailHints = [];

const updateHints = async(file, callback) => {
  readFile(file, 'utf8', (err, data) => {
    if (err) return callback(err);
    try {
      callback(null, JSON.parse(data));
    } catch (err) {
      callback(err);
    }
  });
};

if (VMD_HINTS_FILE) {
  updateHints(VMD_HINTS_FILE, (err, hints) => {
    if (err) {  console.error(err); }
    voicemailHints = hints;

    /* if successful, update the hints every hour */
    setInterval(() => {
      updateHints(VMD_HINTS_FILE, (err, hints) => {
        if (err) {  console.error(err); }
        voicemailHints = hints;
      });
    }, 60000);
  });
}


class Amd extends Emitter {
  constructor(logger, cs, opts) {
    super();
    this.logger = logger;
    this.vendor = opts.recognizer?.vendor || cs.speechRecognizerVendor;
    if ('default' === this.vendor) this.vendor = cs.speechRecognizerVendor;

    this.language = opts.recognizer?.language || cs.speechRecognizerLanguage;
    if ('default' === this.language) this.language = cs.speechRecognizerLanguage;

    this.sttCredentials = cs.getSpeechCredentials(this.vendor, 'stt',
      opts.recognizer?.label || cs.speechRecognizerLabel);

    if (!this.sttCredentials) throw new Error(`No speech credentials found for vendor ${this.vendor}`);

    this.thresholdWordCount = opts.thresholdWordCount || 9;
    const {normalizeTranscription} = require('./transcription-utils')(logger);
    this.normalizeTranscription = normalizeTranscription;
    const {getNuanceAccessToken, getIbmAccessToken} = cs.srf.locals.dbHelpers;
    this.getNuanceAccessToken = getNuanceAccessToken;
    this.getIbmAccessToken = getIbmAccessToken;
    const {setChannelVarsForStt} = require('./transcription-utils')(logger);
    this.setChannelVarsForStt = setChannelVarsForStt;
    this.digitCount = opts.digitCount || 0;
    this.numberRegEx = RegExp(`[0-9]{${this.digitCount}}`);

    const {
      noSpeechTimeoutMs = 5000,
      decisionTimeoutMs = 15000,
      toneTimeoutMs = 20000,
      greetingCompletionTimeoutMs = 2000
    } = opts.timers || {};
    this.noSpeechTimeoutMs = noSpeechTimeoutMs;
    this.decisionTimeoutMs = decisionTimeoutMs;
    this.toneTimeoutMs = toneTimeoutMs;
    this.greetingCompletionTimeoutMs = greetingCompletionTimeoutMs;

    this.beepDetected = false;
  }

  startDecisionTimer() {
    this.decisionTimer = setTimeout(this._onDecisionTimeout.bind(this), this.decisionTimeoutMs);
    this.noSpeechTimer = setTimeout(this._onNoSpeechTimeout.bind(this), this.noSpeechTimeoutMs);
    this.startToneTimer();
  }
  stopDecisionTimer() {
    this.decisionTimer && clearTimeout(this.decisionTimer);
  }
  stopNoSpeechTimer() {
    this.noSpeechTimer && clearTimeout(this.noSpeechTimer);
  }
  startToneTimer() {
    this.toneTimer = setTimeout(this._onToneTimeout.bind(this), this.toneTimeoutMs);
  }
  startGreetingCompletionTimer() {
    this.greetingCompletionTimer = setTimeout(
      this._onGreetingCompletionTimeout.bind(this),
      this.beepDetected ? 1000 : this.greetingCompletionTimeoutMs);
  }
  stopGreetingCompletionTimer() {
    this.greetingCompletionTimer && clearTimeout(this.greetingCompletionTimer);
  }
  restartGreetingCompletionTimer() {
    this.stopGreetingCompletionTimer();
    this.startGreetingCompletionTimer();
  }
  stopToneTimer() {
    this.toneTimer && clearTimeout(this.toneTimer);
  }
  stopAllTimers() {
    this.stopDecisionTimer();
    this.stopNoSpeechTimer();
    this.stopToneTimer();
    this.stopGreetingCompletionTimer();
  }
  _onDecisionTimeout() {
    this.emit(this.decision = AmdEvents.DecisionTimeout);
    this.stopNoSpeechTimer();
  }
  _onToneTimeout() {
    this.emit(AmdEvents.ToneTimeout);
  }
  _onNoSpeechTimeout() {
    this.emit(this.decision = AmdEvents.NoSpeechDetected);
    this.stopDecisionTimer();
  }
  _onGreetingCompletionTimeout() {
    this.emit(AmdEvents.MachineStoppedSpeaking);
  }

  evaluateTranscription(evt) {
    if (this.decision) {
      /* at this point we are only listening for the machine to stop speaking */
      if (this.decision === AmdEvents.MachineDetected) {
        this.restartGreetingCompletionTimer();
      }
      return;
    }
    this.stopNoSpeechTimer();

    this.logger.debug({evt}, 'Amd:evaluateTranscription - raw');
    const t = this.normalizeTranscription(evt, this.vendor, this.language);
    const hints = voicemailHints[this.language] || [];

    this.logger.debug({t}, 'Amd:evaluateTranscription - normalized');

    if (Array.isArray(t.alternatives) && t.alternatives.length > 0) {
      const wordCount = t.alternatives[0].transcript.split(' ').length;
      const final = t.is_final;

      const foundHint = hints.find((h) =>  t.alternatives[0].transcript.toLowerCase().includes(h.toLowerCase()));
      if (foundHint) {
        /* we detected a common voice mail greeting */
        this.logger.debug(`Amd:evaluateTranscription: found hint ${foundHint}`);
        this.emit(this.decision = AmdEvents.MachineDetected, {
          reason: 'hint',
          hint: foundHint,
          language: t.language_code
        });
      }
      else if (this.digitCount != 0 && this.numberRegEx.test(t.alternatives[0].transcript)) {
        /* a string of numbers is typically a machine */
        this.emit(this.decision = AmdEvents.MachineDetected, {
          reason: 'digit count',
          greeting: t.alternatives[0].transcript,
          language: t.language_code
        });
      }
      else if (final && wordCount < this.thresholdWordCount) {
        /* a short greeting is typically a human */
        this.emit(this.decision = AmdEvents.HumanDetected, {
          reason: 'short greeting',
          greeting: t.alternatives[0].transcript,
          language: t.language_code
        });
      }
      else if (wordCount >= this.thresholdWordCount) {
        /* a long greeting is typically a machine */
        this.emit(this.decision = AmdEvents.MachineDetected, {
          reason: 'long greeting',
          greeting: t.alternatives[0].transcript,
          language: t.language_code
        });
      }

      if (this.decision) {
        this.stopDecisionTimer();

        if (this.decision === AmdEvents.MachineDetected) {
          /* if we detected a machine, then wait for greeting to end */
          this.startGreetingCompletionTimer();
        }
      }
      return this.decision;
    }
  }
}

module.exports = (logger) => {
  const startTranscribing = async(cs, ep, task) => {
    const {vendor, language} = ep.amd;
    ep.startTranscription({
      vendor,
      locale: language,
      interim: true,
      bugname
    }).catch((err) => {
      const {writeAlerts, AlertType} = cs.srf.locals;
      ep.amd = null;
      task.emit(AmdEvents.Error, err);
      logger.error(err, 'amd:_startTranscribing error');
      writeAlerts({
        account_sid: cs.accountSid,
        alert_type: AlertType.STT_FAILURE,
        vendor: vendor,
        detail: err.message,
        target_sid: cs.callSid
      });
    }).catch((err) => logger.info({err}, 'Error generating alert for tts failure'));

  };

  const onEndOfUtterance = (cs, ep, task) => {
    logger.debug('amd:onEndOfUtterance');
    startTranscribing(cs, ep, task);
  };
  const onNoSpeechDetected = (cs, ep, task) => {
    logger.debug('amd:onNoSpeechDetected');
    ep.amd.stopAllTimers();
    task.emit(AmdEvents.NoSpeechDetected);
  };
  const onTranscription = (cs, ep, task, evt, fsEvent) => {
    if (fsEvent.getHeader('media-bugname') !== bugname) return;
    ep.amd?.evaluateTranscription(evt);
  };
  const onBeep = (cs, ep, task, evt, fsEvent) => {
    logger.debug({evt, fsEvent}, 'onBeep');
    const frequency = Math.floor(fsEvent.getHeader('Frequency'));
    const variance = Math.floor(fsEvent.getHeader('Frequency-variance'));
    task.emit('amd', {type: AmdEvents.ToneDetected, frequency, variance});
    if (ep.amd) {
      ep.amd.stopToneTimer();
      ep.amd.beepDetected = true;
    }
    ep.execute('avmd_stop').catch((err) => this.logger.info(err, 'Error stopping avmd'));
  };

  const startAmd = async(cs, ep, task, opts) => {
    const amd = ep.amd = new Amd(logger, cs, opts);
    const {vendor, language} = amd;
    let sttCredentials = amd.sttCredentials;
    // hints from configuration might be too long for specific language and vendor that make transcribe freeswitch
    // modules cannot connect to the vendor. hints is used in next step to validate if the transcription
    // matchs voice mail hints.
    const hints = [];

    if (vendor === 'nuance' && sttCredentials.client_id) {
      /* get nuance access token */
      const {getNuanceAccessToken} = amd;
      const {client_id, secret} = sttCredentials;
      const {access_token, servedFromCache} = await getNuanceAccessToken(client_id, secret, 'asr tts');
      logger.debug({client_id}, `Gather:exec - got nuance access token ${servedFromCache ? 'from cache' : ''}`);
      sttCredentials = {...sttCredentials, access_token};
    }
    else if (vendor == 'ibm' && sttCredentials.stt_api_key) {
      /* get ibm access token */
      const {getIbmAccessToken} = amd;
      const {stt_api_key, stt_region} = sttCredentials;
      const {access_token, servedFromCache} = await getIbmAccessToken(stt_api_key);
      logger.debug({stt_api_key}, `Gather:exec - got ibm access token ${servedFromCache ? 'from cache' : ''}`);
      sttCredentials = {...sttCredentials, access_token, stt_region};
    }

    /* set stt options */
    logger.info(`starting amd for vendor ${vendor} and language ${language}`);
    /* if opts contains recognizer object use that config for stt, otherwise use defaults */
    const rOpts = opts.recognizer ?
      opts.recognizer :
      {
        vendor,
        hints,
        enhancedModel: true,
        altLanguages: opts.recognizer?.altLanguages || [],
        initialSpeechTimeoutMs: opts.resolveTimeoutMs,
      };
    const sttOpts = amd.setChannelVarsForStt({name: TaskName.Gather}, sttCredentials, language, rOpts);

    await ep.set(sttOpts).catch((err) => logger.info(err, 'Error setting channel variables'));

    amd.transcriptionHandler = onTranscription.bind(null, cs, ep, task);
    amd.EndOfUtteranceHandler = onEndOfUtterance.bind(null, cs, ep, task);
    amd.noSpeechHandler = onNoSpeechDetected.bind(null, cs, ep, task);

    switch (vendor) {
      case 'google':
        ep.addCustomEventListener(GoogleTranscriptionEvents.Transcription, amd.transcriptionHandler);
        ep.addCustomEventListener(GoogleTranscriptionEvents.EndOfUtterance, amd.EndOfUtteranceHandler);
        break;

      case 'aws':
      case 'polly':
        ep.addCustomEventListener(AwsTranscriptionEvents.Transcription, amd.transcriptionHandler);
        break;
      case 'microsoft':
        ep.addCustomEventListener(AzureTranscriptionEvents.Transcription, amd.transcriptionHandler);
        ep.addCustomEventListener(AzureTranscriptionEvents.NoSpeechDetected, amd.noSpeechHandler);
        break;
      case 'nuance':
        ep.addCustomEventListener(NuanceTranscriptionEvents.Transcription, amd.transcriptionHandler);
        break;

      case 'deepgram':
        ep.addCustomEventListener(DeepgramTranscriptionEvents.Transcription, amd.transcriptionHandler);
        break;

      case 'soniox':
        amd.bugname = 'soniox_amd_transcribe';
        ep.addCustomEventListener(SonioxTranscriptionEvents.Transcription, amd.transcriptionHandler);
        break;

      case 'ibm':
        ep.addCustomEventListener(IbmTranscriptionEvents.Transcription, amd.transcriptionHandler);
        break;

      case 'nvidia':
        ep.addCustomEventListener(NvidiaTranscriptionEvents.Transcription, amd.transcriptionHandler);
        break;

      case 'cobalt':
        ep.addCustomEventListener(CobaltTranscriptionEvents.Transcription, amd.transcriptionHandler);
        break;

      default:
        if (vendor.startsWith('custom:')) {
          ep.addCustomEventListener(JambonzTranscriptionEvents.Transcription, amd.transcriptionHandler);
          break;
        }
        else {
          throw new Error(`Invalid vendor ${this.vendor}`);
        }
    }
    amd
      .on(AmdEvents.NoSpeechDetected, (evt) => {
        task.emit('amd', {type: AmdEvents.NoSpeechDetected, ...evt});
        try {
          stopAmd(ep, task);
        } catch (err) {
          logger.info({err}, 'Error stopping transcription');
        }
      })
      .on(AmdEvents.HumanDetected, (evt) => {
        task.emit('amd', {type: AmdEvents.HumanDetected, ...evt});
        try {
          stopAmd(ep, task);
        } catch (err) {
          logger.info({err}, 'Error stopping transcription');
        }
      })
      .on(AmdEvents.MachineDetected, (evt) => {
        task.emit('amd', {type: AmdEvents.MachineDetected, ...evt});
      })
      .on(AmdEvents.DecisionTimeout, (evt) => {
        task.emit('amd', {type: AmdEvents.DecisionTimeout, ...evt});
        try {
          stopAmd(ep, task);
        } catch (err) {
          logger.info({err}, 'Error stopping transcription');
        }
      })
      .on(AmdEvents.ToneTimeout, (evt) => {
        //task.emit('amd', {type: AmdEvents.ToneTimeout, ...evt});
        try {
          stopAmd(ep, task);
        } catch (err) {
          logger.info({err}, 'Error stopping avmd');
        }
      })
      .on(AmdEvents.MachineStoppedSpeaking, () => {
        task.emit('amd', {type: AmdEvents.MachineStoppedSpeaking});
        try {
          stopAmd(ep, task);
        } catch (err) {
          logger.info({err}, 'Error stopping transcription');
        }
      });

    /* start transcribing, and also listening for beep */
    amd.startDecisionTimer();
    startTranscribing(cs, ep, task);

    ep.addCustomEventListener(AvmdEvents.Beep, onBeep.bind(null, cs, ep, task));
    ep.execute('avmd_start').catch((err) => this.logger.info(err, 'Error starting avmd'));
  };

  const stopAmd = (ep, task) => {
    let vendor;
    if (ep.amd) {
      vendor = ep.amd.vendor;
      ep.amd.stopAllTimers();
      try {
        ep.removeListener(GoogleTranscriptionEvents.Transcription, ep.amd.transcriptionHandler);
        ep.removeListener(GoogleTranscriptionEvents.EndOfUtterance, ep.amd.EndOfUtteranceHandler);
        ep.removeListener(AwsTranscriptionEvents.Transcription, ep.amd.transcriptionHandler);
        ep.removeListener(AzureTranscriptionEvents.Transcription, ep.amd.transcriptionHandler);
        ep.removeListener(AzureTranscriptionEvents.NoSpeechDetected, ep.amd.noSpeechHandler);
        ep.removeListener(NuanceTranscriptionEvents.Transcription, ep.amd.transcriptionHandler);
        ep.removeListener(DeepgramTranscriptionEvents.Transcription, ep.amd.transcriptionHandler);
        ep.removeListener(SonioxTranscriptionEvents.Transcription, ep.amd.transcriptionHandler);
        ep.removeListener(IbmTranscriptionEvents.Transcription, ep.amd.transcriptionHandler);
        ep.removeListener(NvidiaTranscriptionEvents.Transcription, ep.amd.transcriptionHandler);
        ep.removeListener(JambonzTranscriptionEvents.Transcription, ep.amd.transcriptionHandler);
      } catch (error) {
        logger.error('Unable to Remove AMD Listener', error);
      }
      ep.amd = null;
    }

    if (ep.connected) {
      ep.stopTranscription({
        vendor,
        bugname,
        gracefulShutdown: false
      })
        .catch((err) => logger.info(err, 'stopAmd: Error stopping transcription'));
      task.emit('amd', {type: AmdEvents.Stopped});
      ep.execute('avmd_stop').catch((err) => this.logger.info(err, 'Error stopping avmd'));
    }
    ep.removeCustomEventListener(AvmdEvents.Beep);
  };

  return {startAmd, stopAmd};
};
