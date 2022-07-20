const Emitter = require('events');
const {
  GoogleTranscriptionEvents,
  AwsTranscriptionEvents,
  AzureTranscriptionEvents,
  AmdEvents
} = require('./constants');
const bugname = 'amd_bug';
let voicemailHints;

//TODO: should re-read from disk every so often, so it can be updated in situ
if (process.env.VMD_HINTS_FILE) {
  const {VMD_HINTS_FILE} = process.env;
  const {readFile} = require('fs');
  readFile(VMD_HINTS_FILE, 'utf8', (err, data) => {
    if (err) {
      console.error(err);
      return;
    }
    try {
      voicemailHints = JSON.parse(data);
    } catch (err) {
      console.error({err}, `Error parsing ${VMD_HINTS_FILE}`);
    }
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
      toneTimeoutMs = 20000
    } = opts.timers || {};
    this.noSpeechTimeoutMs = noSpeechTimeoutMs;
    this.decisionTimeoutMs = decisionTimeoutMs;
    this.toneTimeoutMs = toneTimeoutMs;
  }

  startDecisionTimer() {
    this.decisionTimer = setTimeout(this._onDecisionTimeout.bind(this), this.decisionTimeoutMs);
    this.noSpeechTimer = setTimeout(this._onNoSpeechTimeout.bind(this), this.noSpeechTimeoutMs);
  }
  stopDecisionTimer() {
    this.decisionTimer && clearTimeout(this.decisionTimer);
  }
  stopNoSpeechTimer() {
    this.noSpeechTimer && clearTimeout(this.noSpeechTimer);
  }
  startToneTimer() {
    this.toneTimer = setTimeout(this._onDecisionTimeout.bind(this), this.decisionTimeoutMs);
  }
  stopToneTimer() {
    this.toneTimer && clearTimeout(this.toneTimer);
  }
  stopAllTimers() {
    this.stopDecisionTimer();
    this.stopNoSpeechTimer();
    this.stopToneTimer();
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

  evaluateTranscription(evt) {
    if (this.decision) return;
    const t = this.normalizeTranscription(evt, this.vendor, this.language);
    const hints = voicemailHints[this.language] || [];

    if (Array.isArray(t.alternatives) && t.alternatives.length > 0) {
      const wordCount = t.alternatives[0].transcript.split(' ').length;
      const final = t.is_final;

      const foundHint = hints.find((h) =>  t.alternatives[0].transcript.includes(h));
      if (foundHint) {
        /* we detected a common voice mail greeting */
        this.logger.debug(`Amd:evaluateTranscription: found hint ${foundHint}`);
        this.emit(this.decision = AmdEvents.MachineDetected);
      }
      else if (final && wordCount < this.thresholdWordCount) {
        /* a short greeting is typically a human */
        this.emit(this.decision = AmdEvents.HumanDetected);
      }
      else if (wordCount >= this.thresholdWordCount) {
        /* a long greeting is typically a machine */
        this.emit(this.decision = AmdEvents.MachineDetected);
      }

      if (this.decision) {
        this.stopDecisionTimer();
        this.stopNoSpeechTimer();
        return this.decision;
      }
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
      this.logger.error(err, 'amd:_startTranscribing error');
      writeAlerts({
        account_sid: cs.accountSid,
        alert_type: AlertType.STT_FAILURE,
        vendor: vendor,
        detail: err.message
      });
    }).catch((err) => this.logger.info({err}, 'Error generating alert for tts failure'));

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
    if (fsEvent.getHeader('media-bugname') !== bugname || ep.amd.remotePartyType) return;
    ep.amd?.evaluateTranscription(evt);
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
    else if (['aws', 'polly'].includes(this.vendor)) {
      Object.assign(sttOpts, {
        AWS_ACCESS_KEY_ID: sttCredentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: sttCredentials.secretAccessKey,
        AWS_REGION: sttCredentials.region
      });
      ep.addCustomEventListener(AwsTranscriptionEvents.Transcription, onTranscription.bind(null, cs, ep, task));
    }
    else if ('microsoft' === this.vendor) {
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
    await ep.set(sttOpts).catch((err) => this.logger.info(err, 'Error setting channel variables'));

    amd
      .on(AmdEvents.NoSpeechDetected, () => {
        task.emit('amd', {type: AmdEvents.NoSpeechDetected});
        ep.stopTranscription({vendor, bugname});
      })
      .on(AmdEvents.HumanDetected, () => {
        task.emit('amd', {type: AmdEvents.HumanDetected});
        ep.stopTranscription({vendor, bugname});
      })
      .on(AmdEvents.MachineDetected, () => {
        task.emit('amd', {type: AmdEvents.MachineDetected});
        ep.stopTranscription({vendor, bugname});
      })
      .on(AmdEvents.DecisionTimeout, () => {
        task.emit('amd', {type: AmdEvents.DecisionTimeout});
        ep.stopTranscription({vendor, bugname});
      })
      .on(AmdEvents.ToneDetected, () => {
        task.emit('amd', {type: AmdEvents.ToneDetected});
      })
      .on(AmdEvents.ToneTimeout, () => {
        task.emit('amd', {type: AmdEvents.ToneTimeout});
      });

    amd.startDecisionTimer();
    startTranscribing(cs, ep, task);
  };

  const stopAmd = (ep, task) => {
    if (ep.amd) {
      ep.amd.stopAllTimers();
      ep.stopTranscription({vendor: ep.amd.vendor, bugname})
        .catch((err) => logger.info(err, 'stopAmd: Error stopping transcription'));
      task.emit('amd', {type: AmdEvents.Stopped});
      ep.amd = null;
    }
  };

  return {startAmd, stopAmd};
};
