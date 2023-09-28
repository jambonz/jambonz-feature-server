const {
  TaskName,
  GoogleTranscriptionEvents,
  NuanceTranscriptionEvents,
  AwsTranscriptionEvents,
  AzureTranscriptionEvents,
  DeepgramTranscriptionEvents,
  SonioxTranscriptionEvents,
  CobaltTranscriptionEvents,
  IbmTranscriptionEvents,
  NvidiaTranscriptionEvents,
  JambonzTranscriptionEvents
} = require('../utils/constants');
const {
  JAMBONES_GATHER_EARLY_HINTS_MATCH,
  JAMBONZ_GATHER_EARLY_HINTS_MATCH,
  JAMBONES_GATHER_CLEAR_GLOBAL_HINTS_ON_EMPTY_HINTS,
} = require('../config');
const makeTask = require('./make_task');
const assert = require('assert');
const SttTask = require('./stt-task');

const compileTranscripts = (logger, evt, arr) => {
  if (!Array.isArray(arr) || arr.length === 0) return;
  let t = '';
  for (const a of arr) {
    t += ` ${a.alternatives[0].transcript}`;
  }
  t += ` ${evt.alternatives[0].transcript}`;
  evt.alternatives[0].transcript = t.trim();
};

class TaskGather extends SttTask {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    [
      'finishOnKey', 'input', 'numDigits', 'minDigits', 'maxDigits',
      'interDigitTimeout', 'partialResultHook', 'bargein', 'dtmfBargein',
      'speechTimeout', 'timeout', 'say', 'play', 'actionHookDelayAction'
    ].forEach((k) => this[k] = this.data[k]);

    /* when collecting dtmf, bargein on dtmf is true unless explicitly set to false */
    if (this.dtmfBargein !== false  && this.input.includes('digits')) this.dtmfBargein = true;

    /* timeout of zero means no timeout */
    this.timeout = this.timeout === 0 ? 0 : (this.timeout || 15) * 1000;
    this.interim = !!this.partialResultHook || this.bargein || (this.timeout > 0);
    this.listenDuringPrompt = this.data.listenDuringPrompt === false ? false : true;
    this.minBargeinWordCount = this.data.minBargeinWordCount || 1;
    if (this.data.recognizer) {
      /* continuous ASR (i.e. compile transcripts until a special timeout or dtmf key) */
      this.asrTimeout = typeof this.data.recognizer.asrTimeout === 'number' ?
        this.data.recognizer.asrTimeout * 1000 : 0;
      if (this.asrTimeout > 0) this.asrDtmfTerminationDigit = this.data.recognizer.asrDtmfTerminationDigit;
      this.isContinuousAsr = this.asrTimeout > 0;

      if (Array.isArray(this.data.recognizer.hints) &&
        0 == this.data.recognizer.hints.length && JAMBONES_GATHER_CLEAR_GLOBAL_HINTS_ON_EMPTY_HINTS) {
        logger.debug('Gather: an empty hints array was supplied, so we will mask global hints');
        this.maskGlobalSttHints = true;
      }
      // fast Recognition, fire event after a specified time after the last hypothesis.
      this.fastRecognitionTimeout =  typeof this.data.recognizer.fastRecognitionTimeout === 'number' ?
        this.data.recognizer.fastRecognitionTimeout * 1000 : 0;
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
    this.partialTranscriptsCount = 0;
  }

  get name() { return TaskName.Gather; }

  get needsStt() { return this.input.includes('speech'); }

  get wantsSingleUtterance() {
    return this.data.recognizer?.singleUtterance === true;
  }

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
    this.logger.debug({options: this.data}, 'Gather:exec');
    await super.exec(cs);
    const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, cs.srf);

    if (cs.hasGlobalSttHints && !this.maskGlobalSttHints) {
      const {hints, hintsBoost} = cs.globalSttHints;
      const setOfHints = new Set((this.data.recognizer.hints || [])
        .concat(hints)
        .filter((h) => typeof h === 'string' && h.length > 0));
      this.data.recognizer.hints = [...setOfHints];
      if (!this.data.recognizer.hintsBoost && hintsBoost) this.data.recognizer.hintsBoost = hintsBoost;
      this.logger.debug({hints: this.data.recognizer.hints, hintsBoost: this.data.recognizer.hintsBoost},
        'Gather:exec - applying global sttHints');
    }
    if (cs.hasAltLanguages) {
      this.data.recognizer.altLanguages = this.data.recognizer.altLanguages.concat(cs.altLanguages);
      this.logger.debug({altLanguages: this.data.recognizer?.altLanguages},
        'Gather:exec - applying altLanguages');
    }
    if (cs.hasGlobalSttPunctuation && !this.data.recognizer.punctuation) {
      this.data.recognizer.punctuation = cs.globalSttPunctuation;
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

    if ((JAMBONZ_GATHER_EARLY_HINTS_MATCH || JAMBONES_GATHER_EARLY_HINTS_MATCH) && this.needsStt &&
      !this.isContinuousAsr &&
      this.data.recognizer?.hints?.length > 0 && this.data.recognizer?.hints?.length <= 10) {
      this.earlyHintsMatch = true;
      this.interim = true;
      this.logger.debug('Gather:exec - early hints match enabled');
    }

    this.ep = ep;
    if ('default' === this.vendor || !this.vendor) {
      this.vendor = cs.speechRecognizerVendor;
      if (this.data.recognizer) this.data.recognizer.vendor = this.vendor;
    }
    if ('default' === this.language || !this.language) {
      this.language = cs.speechRecognizerLanguage;
      if (this.data.recognizer) this.data.recognizer.language = this.language;
    }
    if ('default' === this.label || !this.label) {
      this.label = cs.speechRecognizerLabel;
      if (this.data.recognizer) this.data.recognizer.label = this.label;
    }
    // Fallback options
    if ('default' === this.fallbackVendor || !this.fallbackVendor) {
      this.fallbackVendor = cs.fallbackSpeechRecognizerVendor;
      if (this.data.recognizer) this.data.recognizer.fallbackVendor = this.fallbackVendor;
    }
    if ('default' === this.fallbackLanguage || !this.fallbackLanguage) {
      this.fallbackLanguage = cs.fallbackSpeechRecognizerLanguage;
      if (this.data.recognizer) this.data.recognizer.fallbackLanguage = this.fallbackLanguage;
    }
    if ('default' === this.fallbackLabel || !this.fallbackLabel) {
      this.fallbackLabel = cs.fallbackSpeechRecognizerLabel;
      if (this.data.recognizer) this.data.recognizer.fallbackLabel = this.fallbackLabel;
    }
    if (!this.data.recognizer.vendor) {
      this.data.recognizer.vendor = this.vendor;
    }
    if (this.vendor === 'cobalt' && !this.data.recognizer.model) {
      // By default, application saves cobalt model in language
      this.data.recognizer.model = cs.speechRecognizerLanguage;
    }

    if (this.needsStt && !this.sttCredentials) {
      try {
        this.sttCredentials = await this._initSpeechCredentials(cs, this.vendor, this.label);
      } catch (error) {
        if (this.fallbackVendor && this.isHandledByPrimaryProvider) {
          await this._fallback();
        } else {
          throw error;
        }
      }
    }

    /* when using cobalt model is required */
    if (this.vendor === 'cobalt' && !this.data.recognizer.model) {
      this.notifyError({ msg: 'ASR error', details:'Cobalt requires a model to be specified'});
      throw new Error('Cobalt requires a model to be specified');
    }

    // actionHook delay
    this._actionHookDelayEnabled = cs.actionHookDelayEnabled || !!this.actionHookDelayAction;
    this._actionHookDelayActions = cs.actionHookDelayActions ||
      (this.actionHookDelayAction ? (this.actionHookDelayAction.actions || []) : []);
    if (this._actionHookDelayEnabled && this._actionHookDelayActions.length > 0) {
      this._actionHookNoResponseTimeout = cs.actionHookNoResponseTimeout ||
        (this.actionHookDelayAction ? (this.actionHookDelayAction.noResponseTimeout || 0) * 1000 : 0);
      this._actionHookNoResponseGiveUpTimeout = cs.actionHookNoResponseGiveUpTimeout ||
        (this.actionHookDelayAction ? (this.actionHookDelayAction.noResponseGiveUpTimeout || 0) * 1000 : 0);
      this._actionHookDelayRetries = cs.actionHookDelayRetries ||
        (this.actionHookDelayAction ? (this.actionHookDelayAction.retries || 1) : 0);
      this._actionHookDelayTryCount = 0;
    }

    const startListening = async(cs, ep) => {
      this._startTimer();
      if (this.isContinuousAsr && 0 === this.timeout) this._startAsrTimer();
      if (this.input.includes('speech') && !this.listenDuringPrompt) {
        try {
          await this._setSpeechHandlers(cs, ep);
          if (this.killed) {
            this.logger.info('Gather:exec - task was quickly killed so do not transcribe');
            return;
          }
          this._startTranscribing(ep);
          return updateSpeechCredentialLastUsed(this.sttCredentials.speech_credential_sid);
        } catch (e) {
          if (this.fallbackVendor && this.isHandledByPrimaryProvider) {
            await this._fallback();
            startListening(cs, ep);
          } else {
            this.logger.error({error: e}, 'error in initSpeech');
          }
        }
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
          if (!this.killed) {
            startListening(cs, ep);
            if (this.input.includes('speech') && this.vendor === 'nuance' && this.listenDuringPrompt) {
              this.logger.debug('Gather:exec - starting transcription timers after say completes');
              ep.startTranscriptionTimers((err) => {
                if (err) this.logger.error({err}, 'Gather:exec - error starting transcription timers');
              });
            }
          }
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
          if (!this.killed) {
            startListening(cs, ep);
            if (this.input.includes('speech') && this.vendor === 'nuance' && this.listenDuringPrompt) {
              this.logger.debug('Gather:exec - starting transcription timers after play completes');
              ep.startTranscriptionTimers((err) => {
                if (err) this.logger.error({err}, 'Gather:exec - error starting transcription timers');
              });
            }
          }
        });
      }
      else {
        if (this.killed) {
          this.logger.info('Gather:exec - task was immediately killed so do not transcribe');
          return;
        }
        startListening(cs, ep);
      }

      if (this.input.includes('speech') && this.listenDuringPrompt) {
        await this._setSpeechHandlers(cs, ep);
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
    this.removeSpeechListeners(ep);
  }

  kill(cs) {
    super.kill(cs);
    this._killAudio(cs);
    this._killActionHookDelayAction();
    this.ep.removeAllListeners('dtmf');
    clearTimeout(this.interDigitTimer);
    this._clearAsrTimer();
    this.playTask?.span.end();
    this.sayTask?.span.end();
    this._resolve('killed');
  }

  updateTaskInProgress(opts) {
    if (!this.needsStt && opts.input.includes('speech')) {
      this.logger.info('TaskGather:updateTaskInProgress - adding speech to a background gather');
      return false; // this needs be handled by killing the background gather and starting a new one
    }
    const {timeout} = opts;
    this.timeout = timeout;
    this._startTimer();
    return true;
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

  async _setSpeechHandlers(cs, ep) {
    if (this._speechHandlersSet) return;
    this._speechHandlersSet = true;
    const opts = this.setChannelVarsForStt(this, this.sttCredentials, this.data.recognizer);
    switch (this.vendor) {
      case 'google':
        this.bugname = 'google_transcribe';
        ep.addCustomEventListener(GoogleTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        ep.addCustomEventListener(GoogleTranscriptionEvents.EndOfUtterance, this._onEndOfUtterance.bind(this, cs, ep));
        ep.addCustomEventListener(GoogleTranscriptionEvents.VadDetected, this._onVadDetected.bind(this, cs, ep));
        break;

      case 'aws':
      case 'polly':
        this.bugname = 'aws_transcribe';
        ep.addCustomEventListener(AwsTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        ep.addCustomEventListener(AwsTranscriptionEvents.VadDetected, this._onVadDetected.bind(this, cs, ep));
        break;
      case 'microsoft':
        this.bugname = 'azure_transcribe';
        ep.addCustomEventListener(AzureTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        ep.addCustomEventListener(AzureTranscriptionEvents.NoSpeechDetected,
          this._onNoSpeechDetected.bind(this, cs, ep));
        ep.addCustomEventListener(AzureTranscriptionEvents.VadDetected, this._onVadDetected.bind(this, cs, ep));
        break;
      case 'nuance':
        this.bugname = 'nuance_transcribe';
        ep.addCustomEventListener(NuanceTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep));
        ep.addCustomEventListener(NuanceTranscriptionEvents.StartOfSpeech,
          this._onStartOfSpeech.bind(this, cs, ep));
        ep.addCustomEventListener(NuanceTranscriptionEvents.TranscriptionComplete,
          this._onTranscriptionComplete.bind(this, cs, ep));
        ep.addCustomEventListener(NuanceTranscriptionEvents.VadDetected,
          this._onVadDetected.bind(this, cs, ep));

        /* stall timers until prompt finishes playing */
        if ((this.sayTask || this.playTask) && this.listenDuringPrompt) {
          opts.NUANCE_STALL_TIMERS = 1;
        }
        break;

      case 'deepgram':
        this.bugname = 'deepgram_transcribe';
        ep.addCustomEventListener(DeepgramTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        ep.addCustomEventListener(DeepgramTranscriptionEvents.Connect, this._onDeepgramConnect.bind(this, cs, ep));
        ep.addCustomEventListener(DeepgramTranscriptionEvents.ConnectFailure,
          this._onDeepGramConnectFailure.bind(this, cs, ep));
        break;

      case 'soniox':
        this.bugname = 'soniox_transcribe';
        ep.addCustomEventListener(SonioxTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        break;

      case 'cobalt':
        this.bugname = 'cobalt_transcribe';
        ep.addCustomEventListener(CobaltTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));

        /* cobalt doesnt have language, it has model, which is required */
        if (!this.data.recognizer.model) {
          throw new Error('Cobalt requires a model to be specified');
        }
        this.language = this.data.recognizer.model;

        /* special case: if using hints with cobalt we need to compile them */
        this.hostport = opts.COBALT_SERVER_URI;
        if (this.vendor === 'cobalt' && opts.COBALT_SPEECH_HINTS) {
          try {
            const context = await this.compileHintsForCobalt(
              ep,
              this.hostport,
              this.data.recognizer.model,
              opts.COBALT_CONTEXT_TOKEN,
              opts.COBALT_SPEECH_HINTS
            );
            if (context) opts.COBALT_COMPILED_CONTEXT_DATA = context;
            delete opts.COBALT_SPEECH_HINTS;
          } catch (err) {
            this.logger.error({err}, 'Error compiling hints for cobalt');
          }
        }
        delete opts.COBALT_SERVER_URI;
        break;

      case 'ibm':
        this.bugname = 'ibm_transcribe';
        ep.addCustomEventListener(IbmTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        ep.addCustomEventListener(IbmTranscriptionEvents.Connect, this._onIbmConnect.bind(this, cs, ep));
        ep.addCustomEventListener(IbmTranscriptionEvents.ConnectFailure,
          this._onIbmConnectFailure.bind(this, cs, ep));
        break;

      case 'nvidia':
        this.bugname = 'nvidia_transcribe';
        ep.addCustomEventListener(NvidiaTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep));
        ep.addCustomEventListener(NvidiaTranscriptionEvents.StartOfSpeech,
          this._onStartOfSpeech.bind(this, cs, ep));
        ep.addCustomEventListener(NvidiaTranscriptionEvents.TranscriptionComplete,
          this._onTranscriptionComplete.bind(this, cs, ep));
        ep.addCustomEventListener(NvidiaTranscriptionEvents.VadDetected,
          this._onVadDetected.bind(this, cs, ep));

        /* I think nvidia has this (??) - stall timers until prompt finishes playing */
        if ((this.sayTask || this.playTask) && this.listenDuringPrompt) {
          opts.NVIDIA_STALL_TIMERS = 1;
        }
        break;

      default:
        if (this.vendor.startsWith('custom:')) {
          this.bugname = `${this.vendor}_transcribe`;
          ep.addCustomEventListener(JambonzTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
          ep.addCustomEventListener(JambonzTranscriptionEvents.Connect, this._onJambonzConnect.bind(this, cs, ep));
          ep.addCustomEventListener(JambonzTranscriptionEvents.ConnectFailure,
            this._onJambonzConnectFailure.bind(this, cs, ep));
          break;
        }
        else {
          this.notifyError({ msg: 'ASR error', details:`Invalid vendor ${this.vendor}`});
          this.notifyTaskDone();
          throw new Error(`Invalid vendor ${this.vendor}`);
        }
    }

    /* common handler for all stt engine errors */
    ep.addCustomEventListener(JambonzTranscriptionEvents.Error, this._onJambonzError.bind(this, cs, ep));
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
      hostport: this.hostport,
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

  _hangupCall() {
    this.logger.debug('_hangupCall');
    this.cs.updateCall({call_status: 'completed'}, this.cs.callInfo.callSid);
  }

  _actionHookDelaySayAction(verb) {
    delete verb.verb;
    this.logger.debug(`_actionHookDelaySayAction ${verb}`);
    this._actionHookDelaySayTask = makeTask(this.logger, {say: verb}, this);
    const {span, ctx} = this.startChildSpan(`actionHookDelayAction:${this._actionHookDelaySayTask.summary}`);
    this._actionHookDelaySayTask.span = span;
    this._actionHookDelaySayTask.ctx = ctx;
    this._actionHookDelaySayTask.exec(this.cs, {ep: this.ep});
    this._actionHookDelaySayTask.on('playDone', (err) => {
      this._actionHookDelaySayTask = null;
      span.end();
      if (err) this.logger.error({err}, 'Gather:actionHookDelay Error playing tts');
    });
  }

  _killActionHookDelayAction() {
    this.logger.debug('_killActionHookDelayAction');
    if (this._actionHookDelaySayTask && !this._actionHookDelaySayTask.killed) {
      this._actionHookDelaySayTask.removeAllListeners('playDone');
      this._actionHookDelaySayTask.kill(this.cs);
      this._actionHookDelaySayTask.span.end();
      this._actionHookDelaySayTask = null;
    }

    if (this._actionHookDelayPlayTask && !this._actionHookDelayPlayTask.killed) {
      this._actionHookDelayPlayTask.removeAllListeners('playDone');
      this._actionHookDelayPlayTask.kill(this.cs);
      this._actionHookDelayPlayTask.span.end();
      this._actionHookDelayPlayTask = null;
    }
  }

  _actionHookDelayPlayAction(verb) {
    delete verb.verb;
    this.logger.debug(`_actionHookDelayPlayAction ${verb}`);
    this._actionHookDelayPlayTask = makeTask(this.logger, {play: verb}, this);
    const {span, ctx} = this.startChildSpan(`actionHookDelayAction:${this._actionHookDelayPlayTask.summary}`);
    this._actionHookDelayPlayTask.span = span;
    this._actionHookDelayPlayTask.ctx = ctx;
    this._actionHookDelayPlayTask.exec(this.cs, {ep: this.ep});
    this._actionHookDelayPlayTask.on('playDone', (err) => {
      this._actionHookDelayPlayTask = null;
      span.end();
      if (err) this.logger.error({err}, 'Gather:actionHookDelay Error playing tts');
    });

  }

  _startActionHookNoResponseTimer() {
    assert(this._actionHookNoResponseTimeout > 0);
    this._clearActionHookNoResponseTimer();
    this.logger.debug('startActionHookNoResponseTimer');
    this._actionHookNoResponseTimer = setTimeout(() => {
      if (this._actionHookDelayTryCount >= this._actionHookDelayRetries) {
        this._hangupCall();
        return;
      }
      const verb = this._actionHookDelayActions[this._actionHookDelayTryCount % this._actionHookDelayActions.length];
      if (verb.verb === 'say') {
        this._actionHookDelaySayAction(verb);
      } else if (verb.verb === 'play') {
        this._actionHookDelayPlayAction(verb);
      }
      this._actionHookDelayTryCount++;
      this._startActionHookNoResponseTimer();

    }, this._actionHookNoResponseTimeout);

  }

  _clearActionHookNoResponseTimer() {
    if (this._actionHookNoResponseTimer) {
      clearTimeout(this._actionHookNoResponseTimer);
    }
    this._actionHookNoResponseTimer = null;
  }

  _startActionHookNoResponseGiveUpTimer() {
    assert(this._actionHookNoResponseGiveUpTimeout > 0);
    this._clearActionHookNoResponseGiveUpTimer();
    this.logger.debug('startActionHookNoResponseGiveUpTimer');
    this._actionHookNoResponseGiveUpTimer = setTimeout(() => {
      this._hangupCall();
    }, this._actionHookNoResponseGiveUpTimeout);
  }

  _clearActionHookNoResponseGiveUpTimer() {
    if (this._actionHookNoResponseGiveUpTimer) {
      clearTimeout(this._actionHookNoResponseGiveUpTimer);
    }
    this._actionHookNoResponseGiveUpTimer = null;
  }

  _startFastRecognitionTimer(evt) {
    assert(this.fastRecognitionTimeout > 0);
    this._clearFastRecognitionTimer();
    this._fastRecognitionTimer = setTimeout(() => {
      evt.is_final = true;
      this._resolve('speech', evt);
    }, this.fastRecognitionTimeout);
  }

  _clearFastRecognitionTimer() {
    if (this._fastRecognitionTimer) {
      clearTimeout(this._fastRecognitionTimer);
    }
    this._fastRecognitionTimer = null;
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
    this.logger.debug({evt, bugname, finished}, `Gather:_onTranscription for vendor ${this.vendor}`);
    if (bugname && this.bugname !== bugname) return;

    if (this.vendor === 'ibm') {
      if (evt?.state === 'listening') return;
    }

    evt = this.normalizeTranscription(evt, this.vendor, 1, this.language);
    if (evt.alternatives.length === 0) {
      this.logger.info({evt}, 'TaskGather:_onTranscription - got empty transcript, continue listening');
      return;
    }

    /* fast path: our first partial transcript exactly matches an early hint */
    if (this.earlyHintsMatch && evt.is_final === false && this.partialTranscriptsCount++ === 0) {
      const transcript = evt.alternatives[0].transcript?.toLowerCase();
      const hints = this.data.recognizer?.hints || [];
      if (hints.find((h) => h.toLowerCase() === transcript)) {
        this.logger.debug({evt}, 'Gather:_onTranscription: early hint match');
        this._resolve('speech', evt);
        return;
      }
    }

    /* count words for bargein feature */
    const words = evt.alternatives[0]?.transcript.split(' ').length;
    const bufferedWords = this._sonioxTranscripts.length +
      this._bufferedTranscripts.reduce((count, e) => count + e.alternatives[0]?.transcript.split(' ').length, 0);

    if (evt.is_final) {
      if (evt.alternatives[0].transcript === '' && !this.callSession.callGone && !this.killed) {
        if (finished === 'true' && ['microsoft', 'deepgram'].includes(this.vendor)) {
          this.logger.debug({evt}, 'TaskGather:_onTranscription - got empty transcript from old gather, disregarding');
        }
        else {
          this.logger.info({evt}, 'TaskGather:_onTranscription - got empty transcript, continue listening');
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

        /* some STT engines will keep listening after a final response, so no need to restart */
        if (!['soniox', 'aws', 'microsoft', 'deepgram'].includes(this.vendor)) this._startTranscribing(ep);
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
          if (this.vendor === 'soniox') {
            /* compile transcripts into one */
            this._sonioxTranscripts.push(evt.vendor.finalWords);
            evt = this.compileSonioxTranscripts(this._sonioxTranscripts, 1, this.language);
            this._sonioxTranscripts = [];
          }
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
      this._clearTimer();
      this._startTimer();
      if (this.bargein && (words + bufferedWords) >= this.minBargeinWordCount) {
        if (!this.playComplete) {
          this.logger.debug({transcript: evt.alternatives[0].transcript}, 'killing audio due to speech');
          this.emit('vad');
        }
        this._killAudio(cs);
      }
      if (this.fastRecognitionTimeout) {
        this._startFastRecognitionTimer(evt);
      }
      if (this.partialResultHook) {
        const b3 = this.getTracingPropagation();
        const httpHeaders = b3 && {b3};
        this.cs.requestor.request('verb:hook', this.partialResultHook,  Object.assign({speech: evt},
          this.cs.callInfo, httpHeaders));
      }
      if (this.vendor === 'soniox') {
        this._clearTimer();
        if (evt.vendor.finalWords.length) {
          this.logger.debug({evt}, 'TaskGather:_onTranscription - buffering soniox transcript');
          this._sonioxTranscripts.push(evt.vendor.finalWords);
        }
      }
    }
  }
  _onEndOfUtterance(cs, ep) {
    this.logger.debug('TaskGather:_onEndOfUtterance');
    if (this.bargein && this.minBargeinWordCount === 0) {
      this._killAudio(cs);
    }

    /**
     * By default, Gather asks google for multiple utterances.
     * The reason is that we can sometimes get an 'end_of_utterance' event without
     * getting a transcription.  This can happen if someone coughs or mumbles.
     * For that reason don't ask for a single utterance and we'll terminate the transcribe operation
     * once we get a final transcript.
     * However, if the usr has specified a singleUtterance, then we need to restart here
     * since we dont have a final transcript yet.
     */
    if (!this.resolved && !this.killed && !this._bufferedTranscripts.length && this.wantsSingleUtterance) {
      this._startTranscribing(ep);
    }
  }

  _onStartOfSpeech(cs, ep) {
    this.logger.debug('TaskGather:_onStartOfSpeech');
    if (this.bargein) {
      this._killAudio(cs);
    }
  }
  _onTranscriptionComplete(cs, ep) {
    this.logger.debug('TaskGather:_onTranscriptionComplete');
  }
  _onDeepgramConnect(_cs, _ep) {
    this.logger.debug('TaskGather:_onDeepgramConnect');
  }
  _onJambonzConnect(_cs, _ep) {
    this.logger.debug('TaskGather:_onJambonzConnect');
  }
  async _onJambonzError(cs, ep, evt) {
    this.logger.info({evt}, 'TaskGather:_onJambonzError');
    if (this.isHandledByPrimaryProvider && this.fallbackVendor) {
      ep.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.error({err}, `Error stopping transcription for primary vendor ${this.vendor}`));
      const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, cs.srf);
      try {
        await this._fallback();
        await this._initSpeech(cs, ep);
        this._startTranscribing(ep);
        updateSpeechCredentialLastUsed(this.sttCredentials.speech_credential_sid);
        return;
      } catch (error) {
        this.logger.info({error}, `There is error while falling back to ${this.fallbackVendor}`);
      }
    }
    const {writeAlerts, AlertType} = cs.srf.locals;

    if (this.vendor === 'nuance') {
      const {code, error} = evt;
      if (code === 404 && error === 'No speech') return this._resolve('timeout');
      if (code === 413 && error === 'Too much speech') return this._resolve('timeout');
    }
    this.logger.info({evt}, 'TaskGather:_onJambonzError');
    writeAlerts({
      account_sid: cs.accountSid,
      alert_type: AlertType.STT_FAILURE,
      message: `Custom speech vendor ${this.vendor} error: ${evt.error}`,
      vendor: this.vendor,
    }).catch((err) => this.logger.info({err}, 'Error generating alert for jambonz custom connection failure'));
    this.notifyError({msg: 'ASR error', details:`Custom speech vendor ${this.vendor} error: ${evt.error}`});
  }

  _onDeepGramConnectFailure(cs, _ep, evt) {
    const {reason} = evt;
    const {writeAlerts, AlertType} = cs.srf.locals;
    this.logger.info({evt}, 'TaskGather:_onDeepgramConnectFailure');
    writeAlerts({
      account_sid: cs.accountSid,
      alert_type: AlertType.STT_FAILURE,
      message: `Failed connecting to Deepgram speech recognizer: ${reason}`,
      vendor: 'deepgram',
    }).catch((err) => this.logger.info({err}, 'Error generating alert for deepgram connection failure'));
    this.notifyError({msg: 'ASR error', details:`Failed connecting to speech vendor deepgram: ${reason}`});
    this.notifyTaskDone();
  }
  _onJambonzConnectFailure(cs, _ep, evt) {
    const {reason} = evt;
    const {writeAlerts, AlertType} = cs.srf.locals;
    this.logger.info({evt}, 'TaskGather:_onJambonzConnectFailure');
    writeAlerts({
      account_sid: cs.accountSid,
      alert_type: AlertType.STT_FAILURE,
      message: `Failed connecting to ${this.vendor} speech recognizer: ${reason}`,
      vendor: this.vendor,
    }).catch((err) => this.logger.info({err}, 'Error generating alert for jambonz custom connection failure'));
    this.notifyError({msg: 'ASR error', details:`Failed connecting to speech vendor ${this.vendor}: ${reason}`});
    this.notifyTaskDone();
  }

  _onIbmConnect(_cs, _ep) {
    this.logger.debug('TaskGather:_onIbmConnect');
  }

  _onIbmConnectFailure(cs, _ep, evt) {
    const {reason} = evt;
    const {writeAlerts, AlertType} = cs.srf.locals;
    this.logger.info({evt}, 'TaskGather:_onIbmConnectFailure');
    writeAlerts({
      account_sid: cs.accountSid,
      alert_type: AlertType.STT_FAILURE,
      message: `Failed connecting to IBM watson speech recognizer: ${reason}`,
      vendor: 'ibm',
    }).catch((err) => this.logger.info({err}, 'Error generating alert for IBM connection failure'));
    this.notifyError({msg: 'ASR error', details:`Failed connecting to speech vendor IBM: ${reason}`});
    this.notifyTaskDone();
  }

  _onIbmError(cs, _ep, evt) {
    this.logger.info({evt}, 'TaskGather:_onIbmError');  }

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
    // Clear dtmf event
    if (this.dtmfBargein) {
      this.ep.removeAllListeners('dtmf');
    }
    clearTimeout(this.interDigitTimer);
    this._clearTimer();
    this._clearFastRecognitionTimer();

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

    this.span.setAttributes({
      channel: 1,
      'stt.resolve': reason,
      'stt.result': JSON.stringify(evt)
    });
    if (this.needsStt && this.ep && this.ep.connected) {
      this.ep.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.error({err}, 'Error stopping transcription'));
    }

    if (this.callSession && this.callSession.callGone) {
      this.logger.debug('TaskGather:_resolve - call is gone, not invoking web callback');
      this.notifyTaskDone();
      return;
    }

    // Enabled action Hook delay timer to applied actions
    if (this._actionHookNoResponseTimeout > 0) {
      this._startActionHookNoResponseTimer();
    }

    if (this._actionHookNoResponseGiveUpTimeout > 0) {
      this._startActionHookNoResponseGiveUpTimer();
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

    // Gather got response from hook, cancel all delay timers if there is any
    this._clearActionHookNoResponseTimer();
    this._clearActionHookNoResponseGiveUpTimer();

    this.notifyTaskDone();
  }
}

module.exports = TaskGather;
