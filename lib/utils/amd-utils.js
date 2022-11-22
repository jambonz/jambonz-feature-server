const Emitter = require('events');
const {readFile} = require('fs');
const {
  GoogleTranscriptionEvents,
  AwsTranscriptionEvents,
  AzureTranscriptionEvents,
  AmdEvents,
  AvmdEvents
} = require('./constants');
const bugname = 'amd_bug';
const {VMD_HINTS_FILE} = process.env;
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

    this.sttCredentials = cs.getSpeechCredentials(this.vendor, 'stt');

    if (!this.sttCredentials) throw new Error(`No speech credentials found for vendor ${this.vendor}`);

    this.thresholdWordCount = opts.thresholdWordCount || 9;
    const {normalizeTranscription} = require('./transcription-utils')(logger);
    this.normalizeTranscription = normalizeTranscription;

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

      const foundHint = hints.find((h) =>  t.alternatives[0].transcript.includes(h));
      if (foundHint) {
        /* we detected a common voice mail greeting */
        this.logger.debug(`Amd:evaluateTranscription: found hint ${foundHint}`);
        this.emit(this.decision = AmdEvents.MachineDetected, {
          reason: 'hint',
          hint: foundHint,
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
      language,
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
        detail: err.message
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
    const {vendor, language, sttCredentials} = amd;
    const sttOpts = {};
    const hints = voicemailHints[language] || [];

    /* set stt options */
    logger.info(`starting amd for vendor ${vendor} and language ${language}`);
    if ('google' === vendor) {
      sttOpts.GOOGLE_APPLICATION_CREDENTIALS = JSON.stringify(sttCredentials.credentials);
      sttOpts.GOOGLE_SPEECH_USE_ENHANCED = true;
      sttOpts.GOOGLE_SPEECH_HINTS = hints.join(',');
      if (opts.recognizer?.altLanguages) {
        sttOpts.GOOGLE_SPEECH_ALTERNATIVE_LANGUAGE_CODES = opts.recognizer.altLanguages.join(',');
      }
      ep.addCustomEventListener(GoogleTranscriptionEvents.Transcription, onTranscription.bind(null, cs, ep, task));
      ep.addCustomEventListener(GoogleTranscriptionEvents.EndOfUtterance, onEndOfUtterance.bind(null, cs, ep, task));
    }
    else if (['aws', 'polly'].includes(vendor)) {
      Object.assign(sttOpts, {
        AWS_ACCESS_KEY_ID: sttCredentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: sttCredentials.secretAccessKey,
        AWS_REGION: sttCredentials.region
      });
      ep.addCustomEventListener(AwsTranscriptionEvents.Transcription, onTranscription.bind(null, cs, ep, task));
    }
    else if ('microsoft' === vendor) {
      Object.assign(sttOpts, {
        'AZURE_SUBSCRIPTION_KEY': sttCredentials.api_key,
        'AZURE_REGION': sttCredentials.region
      });
      sttOpts.AZURE_SPEECH_HINTS = hints.join(',');
      if (opts.recognizer?.altLanguages) {
        sttOpts.AZURE_SPEECH_ALTERNATIVE_LANGUAGE_CODES = opts.recognizer.altLanguages.join(',');
      }
      sttOpts.AZURE_INITIAL_SPEECH_TIMEOUT_MS = opts.resolveTimeoutMs || 20000;

      ep.addCustomEventListener(AzureTranscriptionEvents.Transcription, onTranscription.bind(null, cs, ep, task));
      ep.addCustomEventListener(AzureTranscriptionEvents.NoSpeechDetected, onNoSpeechDetected.bind(null, cs, ep, task));
    }
    logger.debug({sttOpts}, 'startAmd: setting channel vars');
    await ep.set(sttOpts).catch((err) => logger.info(err, 'Error setting channel variables'));

    amd
      .on(AmdEvents.NoSpeechDetected, (evt) => {
        task.emit('amd', {type: AmdEvents.NoSpeechDetected, ...evt});
        try {
          ep.connected && ep.stopTranscription({vendor, bugname});
        } catch (err) {
          logger.info({err}, 'Error stopping transcription');
        }
      })
      .on(AmdEvents.HumanDetected, (evt) => {
        task.emit('amd', {type: AmdEvents.HumanDetected, ...evt});
        try {
          ep.connected && ep.stopTranscription({vendor, bugname});
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
          ep.connected && ep.stopTranscription({vendor, bugname});
        } catch (err) {
          logger.info({err}, 'Error stopping transcription');
        }
      })
      .on(AmdEvents.ToneTimeout, (evt) => {
        //task.emit('amd', {type: AmdEvents.ToneTimeout, ...evt});
        try {
          ep.connected && ep.execute('avmd_stop').catch((err) => logger.info(err, 'Error stopping avmd'));
        } catch (err) {
          logger.info({err}, 'Error stopping avmd');
        }
      })
      .on(AmdEvents.MachineStoppedSpeaking, () => {
        task.emit('amd', {type: AmdEvents.MachineStoppedSpeaking});
        try {
          ep.connected && ep.stopTranscription({vendor, bugname});
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
      ep.amd = null;
    }

    if (ep.connected) {
      ep.stopTranscription({vendor, bugname})
        .catch((err) => logger.info(err, 'stopAmd: Error stopping transcription'));
      task.emit('amd', {type: AmdEvents.Stopped});
      ep.execute('avmd_stop').catch((err) => this.logger.info(err, 'Error stopping avmd'));
    }
    ep.removeCustomEventListener(AvmdEvents.Beep);
  };

  return {startAmd, stopAmd};
};
