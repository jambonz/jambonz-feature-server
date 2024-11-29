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
  JambonzTranscriptionEvents,
  AssemblyAiTranscriptionEvents,
  VadDetection,
  VerbioTranscriptionEvents,
  SpeechmaticsTranscriptionEvents
} = require('../utils/constants.json');
const {
  JAMBONES_GATHER_EARLY_HINTS_MATCH,
  JAMBONZ_GATHER_EARLY_HINTS_MATCH,
  JAMBONES_GATHER_CLEAR_GLOBAL_HINTS_ON_EMPTY_HINTS,
} = require('../config');
const makeTask = require('./make_task');
const assert = require('assert');
const SttTask = require('./stt-task');
const { SpeechCredentialError } = require('../utils/error');

class TaskGather extends SttTask {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    [
      'finishOnKey', 'input', 'numDigits', 'minDigits', 'maxDigits',
      'interDigitTimeout', 'partialResultHook', 'bargein', 'dtmfBargein',
      'speechTimeout', 'timeout', 'say', 'play', 'actionHookDelayAction', 'fillerNoise', 'vad'
    ].forEach((k) => this[k] = this.data[k]);

    // gather default input is digits
    if (!this.input) {
      this.input = ['digits'];
    }
    /* when collecting dtmf, bargein on dtmf is true unless explicitly set to false */
    if (this.dtmfBargein !== false  && this.input.includes('digits')) this.dtmfBargein = true;

    /* timeout of zero means no timeout */
    this.timeout = this.timeout === 0 ? 0 : (this.timeout || 15) * 1000;
    this.interim = !!this.partialResultHook || this.bargein || (this.timeout > 0);
    this.listenDuringPrompt = this.data.listenDuringPrompt === false ? false : true;
    this.minBargeinWordCount = this.data.minBargeinWordCount !== undefined ? this.data.minBargeinWordCount : 1;
    this._vadEnabled = this.minBargeinWordCount === 0;
    if (this.data.recognizer) {
      /* continuous ASR (i.e. compile transcripts until a special timeout or dtmf key) */
      this.asrTimeout = typeof this.data.recognizer.asrTimeout === 'number' ?
        this.data.recognizer.asrTimeout * 1000 : 0;
      if (this.asrTimeout > 0) {
        this.isContinuousAsr = true;
        this.asrDtmfTerminationDigit = this.data.recognizer.asrDtmfTerminationDigit;
      }

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
    this.bugname_prefix = 'gather_';
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

  get hasFillerNoise() {
    return Object.keys(this.fillerNoise).length > 0 && this.fillerNoise.enabled !== false;
  }

  get fillerNoiseUrl() {
    return this.fillerNoise.url;
  }

  get fillerNoiseStartDelaySecs() {
    return this.fillerNoise.startDelaySecs;
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
    if (this.actionHookDelayAction) s += ',with actionHookDelayAction';
    s += '}';
    return s;
  }

  async exec(cs, obj) {
    try {
      await this.handling(cs, obj);
    } catch (error) {
      if (error instanceof SpeechCredentialError) {
        this.logger.info('Gather failed due to SpeechCredentialError, finished!');
        this.notifyTaskDone();
        return;
      }
      throw error;
    }
  }

  async handling(cs, {ep}) {
    this.logger.debug({options: this.data}, 'Gather:exec');
    await super.exec(cs, {ep});

    this.fillerNoise = {
      ...(cs.fillerNoise || {}),
      ...(this.fillerNoise || {})
    };

    this.vad = {
      ...(cs.vad || {}),
      ...(this.vad || {})
    };

    if (cs.hasGlobalSttHints && !this.maskGlobalSttHints) {
      const {hints, hintsBoost} = cs.globalSttHints;
      const setOfHints = new Set((this.data.recognizer.hints || [])
        .concat(hints)
        // allow for hints to be an array of object
        .filter((h) => (typeof h === 'string' && h.length > 0) || (typeof h === 'object')));
      this.data.recognizer.hints = [...setOfHints];
      if (!this.data.recognizer.hintsBoost && hintsBoost) this.data.recognizer.hintsBoost = hintsBoost;
      this.logger.debug({hints: this.data.recognizer.hints, hintsBoost: this.data.recognizer.hintsBoost},
        'Gather:exec - applying global sttHints');
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

    // if we have actionHook delay, and the session does as well, stash the session config
    if (this.actionHookDelayAction) {
      if (cs.actionHookDelayProcessor) {
        this.logger.debug('Gather:exec - stashing session-level ahd proprerties');
        cs.stashActionHookDelayProperties();
      }
      cs.actionHookDelayProperties = this.actionHookDelayAction;
    }

    this._startVad();

    const startDtmfListener = () => {
      assert(!this._dtmfListenerStarted);
      if (this.input.includes('digits') || this.dtmfBargein || this.asrDtmfTerminationDigit) {
        ep.on('dtmf', this._onDtmf.bind(this, cs, ep));
        this._dtmfListenerStarted = true;
      }
    };

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
        } catch (e) {
          await this._startFallback(cs, ep, {error: e});
        }
      }
    };

    try {
      if (this.sayTask) {
        const {span, ctx} = this.startChildSpan(`nested:${this.sayTask.summary}`);
        const process = () => {
          this.logger.debug('Gather: nested say task completed');
          if (!this.listenDuringPrompt) {
            startDtmfListener();
          }
          this._stopVad();
          if (!this.killed) {
            startListening(cs, ep);
            if (this.input.includes('speech') && this.vendor === 'nuance' && this.listenDuringPrompt) {
              this.logger.debug('Gather:exec - starting transcription timers after say completes');
              ep.startTranscriptionTimers((err) => {
                if (err) this.logger.error({err}, 'Gather:exec - error starting transcription timers');
              });
            }
          }
        };
        this.sayTask.span = span;
        this.sayTask.ctx = ctx;
        this.sayTask.exec(cs, {ep})  // kicked off, _not_ waiting for it to complete
          .catch((err) => {
            process();
          });
        this.sayTask.on('playDone', (err) => {
          span.end();
          if (err) this.logger.error({err}, 'Gather:exec Error playing tts');
          process();
        });
      }
      else if (this.playTask) {
        const {span, ctx} = this.startChildSpan(`nested:${this.playTask.summary}`);
        const process = () => {
          this.logger.debug('Gather: nested play task completed');
          if (!this.listenDuringPrompt) {
            startDtmfListener();
          }
          this._stopVad();
          if (!this.killed) {
            startListening(cs, ep);
            if (this.input.includes('speech') && this.vendor === 'nuance' && this.listenDuringPrompt) {
              this.logger.debug('Gather:exec - starting transcription timers after play completes');
              ep.startTranscriptionTimers((err) => {
                if (err) this.logger.error({err}, 'Gather:exec - error starting transcription timers');
              });
            }
          }
        };
        this.playTask.span = span;
        this.playTask.ctx = ctx;
        this.playTask.exec(cs, {ep})  // kicked off, _not_ waiting for it to complete
          .catch((err) => {
            process();
          });
        this.playTask.on('playDone', (err) => {
          span.end();
          if (err) this.logger.error({err}, 'Gather:exec Error playing url');
          process();
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
        if (!this.resolved && !this.killed) {
          this._startTranscribing(ep);
        }
        else {
          this.logger.info('Gather:exec - task was killed or resolved quickly, not starting transcription');
        }
      }

      // https://github.com/jambonz/jambonz-feature-server/issues/913
      if (this.listenDuringPrompt || (!this.sayTask && !this.playTask)) {
        startDtmfListener();
      }

      await this.awaitTaskDone();
      this._killAudio(cs);
    } catch (err) {
      this.logger.error(err, 'TaskGather:exec error');
    }
    this.removeCustomEventListeners();
  }

  kill(cs) {
    super.kill(cs);
    this._killAudio(cs);
    this._clearFillerNoiseTimer();
    this.ep.removeAllListeners('dtmf');
    clearTimeout(this.interDigitTimer);
    this._clearAsrTimer();
    this.playTask?.span.end();
    this.sayTask?.span.end();
    this._stopVad();
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
      if (!this.playComplete) {
        this.notifyStatus({event: 'dtmf-bargein-detected', ...evt});
      }
      this._killAudio(cs);
      this.emit('dtmf', evt);
    }
    if (this.isContinuousAsr && evt.dtmf === this.asrDtmfTerminationDigit && this._bufferedTranscripts.length > 0) {
      this.logger.info(`continuousAsr triggered with dtmf ${this.asrDtmfTerminationDigit}`);
      this._clearAsrTimer();
      this._clearTimer();
      this._startFinalAsrTimer();
      return;
    }
    if (evt.dtmf === this.finishOnKey && this.input.includes('digits')) {
      resolved = true;
      this._resolve('dtmf-terminator-key');
    }
    else if (this.input.includes('digits')) {
      if (this.digitBuffer.length === 0 && this.needsStt) {
        // DTMF is higher priority than STT.
        this.removeCustomEventListeners();
        ep.stopTranscription({
          vendor: this.vendor,
          bugname: this.bugname,
        })
          .catch((err) => this.logger.error({err},
            ` Received DTMF, Error stopping transcription for vendor ${this.vendor}`));
      }
      this.digitBuffer += evt.dtmf;
      const len = this.digitBuffer.length;
      if (len === this.numDigits || len === this.maxDigits) {
        resolved = true;
        this._resolve('dtmf-num-digits');
      }
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

    /* some special deepgram logic */
    if (this.vendor === 'deepgram') {
      if (this.isContinuousAsr) this._doContinuousAsrWithDeepgram(this.asrTimeout);
      if (this.data.recognizer?.deepgramOptions?.shortUtterance) this.shortUtterance = true;
    }

    const opts = this.setChannelVarsForStt(this, this.sttCredentials, this.language, this.data.recognizer);
    switch (this.vendor) {
      case 'google':
        this.bugname = `${this.bugname_prefix}google_transcribe`;
        this.addCustomEventListener(
          ep, GoogleTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        this.addCustomEventListener(
          ep, GoogleTranscriptionEvents.EndOfUtterance, this._onEndOfUtterance.bind(this, cs, ep));
        break;

      case 'aws':
      case 'polly':
        this.bugname = `${this.bugname_prefix}aws_transcribe`;
        this.addCustomEventListener(ep, AwsTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        break;
      case 'microsoft':
        this.bugname = `${this.bugname_prefix}azure_transcribe`;
        this.addCustomEventListener(
          ep, AzureTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        //this.addCustomEventListener(ep, AzureTranscriptionEvents.NoSpeechDetected,
        //this._onNoSpeechDetected.bind(this, cs, ep));
        break;
      case 'nuance':
        this.bugname = `${this.bugname_prefix}nuance_transcribe`;
        this.addCustomEventListener(ep, NuanceTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep));
        this.addCustomEventListener(ep, NuanceTranscriptionEvents.StartOfSpeech,
          this._onStartOfSpeech.bind(this, cs, ep));
        this.addCustomEventListener(ep, NuanceTranscriptionEvents.TranscriptionComplete,
          this._onTranscriptionComplete.bind(this, cs, ep));

        /* stall timers until prompt finishes playing */
        if ((this.sayTask || this.playTask) && this.listenDuringPrompt) {
          opts.NUANCE_STALL_TIMERS = 1;
        }
        break;

      case 'deepgram':
        this.bugname = `${this.bugname_prefix}deepgram_transcribe`;
        this.addCustomEventListener(
          ep, DeepgramTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        this.addCustomEventListener(ep, DeepgramTranscriptionEvents.Connect, this._onVendorConnect.bind(this, cs, ep));
        this.addCustomEventListener(ep, DeepgramTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep));
        break;

      case 'soniox':
        this.bugname = `${this.bugname_prefix}soniox_transcribe`;
        this.addCustomEventListener(
          ep, SonioxTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        break;

      case 'verbio':
        this.bugname = `${this.bugname_prefix}verbio_transcribe`;
        this.addCustomEventListener(
          ep, VerbioTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        break;

      case 'cobalt':
        this.bugname = `${this.bugname_prefix}cobalt_transcribe`;
        this.addCustomEventListener(
          ep, CobaltTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));

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
        this.bugname = `${this.bugname_prefix}ibm_transcribe`;
        this.addCustomEventListener(ep, IbmTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        this.addCustomEventListener(ep, IbmTranscriptionEvents.Connect, this._onVendorConnect.bind(this, cs, ep));
        this.addCustomEventListener(ep, IbmTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep));
        break;

      case 'nvidia':
        this.bugname = `${this.bugname_prefix}nvidia_transcribe`;
        this.addCustomEventListener(ep, NvidiaTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep));
        this.addCustomEventListener(ep, NvidiaTranscriptionEvents.StartOfSpeech,
          this._onStartOfSpeech.bind(this, cs, ep));
        this.addCustomEventListener(ep, NvidiaTranscriptionEvents.TranscriptionComplete,
          this._onTranscriptionComplete.bind(this, cs, ep));

        /* I think nvidia has this (??) - stall timers until prompt finishes playing */
        if ((this.sayTask || this.playTask) && this.listenDuringPrompt) {
          opts.NVIDIA_STALL_TIMERS = 1;
        }
        break;

      case 'assemblyai':
        this.bugname = `${this.bugname_prefix}assemblyai_transcribe`;
        this.addCustomEventListener(ep, AssemblyAiTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep));
        this.addCustomEventListener(
          ep, AssemblyAiTranscriptionEvents.Connect, this._onVendorConnect.bind(this, cs, ep));
        this.addCustomEventListener(ep, AssemblyAiTranscriptionEvents.Error, this._onVendorError.bind(this, cs, ep));
        this.addCustomEventListener(ep, AssemblyAiTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep));
        break;

      case 'speechmatics':
        this.bugname = `${this.bugname_prefix}speechmatics_transcribe`;
        this.addCustomEventListener(
          ep, SpeechmaticsTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        this.addCustomEventListener(ep, SpeechmaticsTranscriptionEvents.Info,
          this._onSpeechmaticsInfo.bind(this, cs, ep));
        this.addCustomEventListener(ep, SpeechmaticsTranscriptionEvents.RecognitionStarted,
          this._onSpeechmaticsRecognitionStarted.bind(this, cs, ep));
        this.addCustomEventListener(ep, SpeechmaticsTranscriptionEvents.Connect,
          this._onVendorConnect.bind(this, cs, ep));
        this.addCustomEventListener(ep, SpeechmaticsTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep));
        this.addCustomEventListener(ep, SpeechmaticsTranscriptionEvents.Error,
          this._onSpeechmaticsErrror.bind(this, cs, ep));

        break;

      default:
        if (this.vendor.startsWith('custom:')) {
          this.bugname = `${this.bugname_prefix}${this.vendor}_transcribe`;
          this.addCustomEventListener(
            ep, JambonzTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
          this.addCustomEventListener(ep, JambonzTranscriptionEvents.Connect, this._onVendorConnect.bind(this, cs, ep));
          this.addCustomEventListener(ep, JambonzTranscriptionEvents.ConnectFailure,
            this._onVendorConnectFailure.bind(this, cs, ep));
          break;
        }
        else {
          this.notifyError({ msg: 'ASR error', details:`Invalid vendor ${this.vendor}`});
          this.notifyTaskDone();
          throw new Error(`Invalid vendor ${this.vendor}`);
        }
    }

    /* common handler for all stt engine errors */
    this.addCustomEventListener(ep, JambonzTranscriptionEvents.Error, this._onJambonzError.bind(this, cs, ep));
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

    /**
     * Note: we don't need to ask deepgram for interim results, because they
     * already send us words as they are finalized (is_final=true) even before
     * the utterance is finalized (speech_final=true)
     */
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
        detail: err.message,
        target_sid: this.cs.callSid
      });
    }).catch((err) => this.logger.info({err}, 'Error generating alert for tts failure'));
  }

  _startTimer() {
    if (0 === this.timeout) return;
    this._clearTimer();
    this._timeoutTimer = setTimeout(() => {
      if (this.isContinuousAsr) this._startAsrTimer();
      if (this.interDigitTimer) return; // let the inter-digit timer complete
      else {
        this._resolve(this.digitBuffer.length >= this.minDigits ? 'dtmf-num-digits' : 'timeout');
      }
    }, this.timeout);
  }

  _clearTimer() {
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
      return true;
    }
    return false;
  }

  _startAsrTimer() {
    if (this.vendor === 'deepgram') return; // no need
    assert(this.isContinuousAsr);
    this._clearAsrTimer();
    this._asrTimer = setTimeout(() => {
      this.logger.debug('_startAsrTimer - asr timer went off');
      const evt = this.consolidateTranscripts(this._bufferedTranscripts, 1, this.language, this.vendor);
      this._resolve(this._bufferedTranscripts.length > 0 ? 'speech' : 'timeout', evt);
    }, this.asrTimeout);
    this.logger.debug(`_startAsrTimer: set for ${this.asrTimeout}ms`);
  }

  _clearAsrTimer() {
    if (this._asrTimer) {
      this.logger.debug('_clearAsrTimer: asrTimer cleared');
      clearTimeout(this._asrTimer);
    }
    this._asrTimer = null;
  }

  _hangupCall() {
    this.logger.debug('_hangupCall');
    this.cs.hangup();
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
      const evt = this.consolidateTranscripts(this._bufferedTranscripts, 1, this.language, this.vendor);
      this._resolve(this._bufferedTranscripts.length > 0 ? 'speech' : 'timeout', evt);
    }, 1000);
    this.logger.debug('_startFinalAsrTimer: set for 1 second');
  }

  _clearFinalAsrTimer() {
    if (this._finalAsrTimer) clearTimeout(this._finalAsrTimer);
    this._finalAsrTimer = null;
  }


  _startVad() {
    if (!this._vadStarted && this._vadEnabled) {
      this.logger.debug('_startVad');
      this.addCustomEventListener(this.ep, VadDetection.Detection, this._onVadDetected.bind(this, this.cs, this.ep));
      this.ep?.startVadDetection(this.vad);
      this._vadStarted = true;
    }
  }

  _stopVad() {
    if (this._vadStarted) {
      this.logger.debug('_stopVad');
      this.ep?.stopVadDetection(this.vad);
      this.ep?.removeCustomEventListener(VadDetection.Detection, this._onVadDetected);
      this._vadStarted = false;
    }
  }

  _startFillerNoise() {
    this.logger.debug('Gather:_startFillerNoise - playing filler noise');
    this.ep?.play(this.fillerNoise.url);
    this._fillerNoiseOn = true;
    this.ep.once('playback-start', (evt) => {
      if (evt.file === this.fillerNoise.url && !this._fillerNoiseOn) {
        this.logger.info({evt}, 'Gather:_startFillerNoise - race condition - kill filler noise here');
        this.ep.api('uuid_break', this.ep.uuid)
          .catch((err) => this.logger.info(err, 'Error killing filler noise'));
        return;
      } else this.logger.debug({evt}, 'Gather:_startFillerNoise - playback started');
    });
  }

  _startFillerNoiseTimer() {
    this._clearFillerNoiseTimer();
    this._fillerNoiseTimer = setTimeout(() => {
      this.logger.debug('Gather:_startFillerNoiseTimer - playing filler noise');
      this._startFillerNoise();
    }, this.fillerNoise.startDelaySecs * 1000);
  }

  _clearFillerNoiseTimer() {
    if (this._fillerNoiseTimer) clearTimeout(this._fillerNoiseTimer);
    this._fillerNoiseTimer = null;
  }

  _killFillerNoise() {
    if (this._fillerNoiseTimer) {
      this.logger.debug('Gather:_killFillerNoise');
      this.ep?.api('uuid_break', this.ep.uuid);
    }
  }

  _killAudio(cs) {
    if (this.hasFillerNoise || (!this.sayTask && !this.playTask && this.bargein)) {
      if (this.ep?.connected && (!this.playComplete || this.hasFillerNoise)) {
        this.logger.debug('Gather:_killAudio: killing playback of any audio');
        this.playComplete = true;
        this._fillerNoiseOn = false;  // in a race, if we just started audio it may sneak through here
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
    this.playComplete = true;
  }

  _onTranscription(cs, ep, evt, fsEvent) {
    // make sure this is not a transcript from answering machine detection
    const bugname = fsEvent.getHeader('media-bugname');
    const finished = fsEvent.getHeader('transcription-session-finished');
    this.logger.debug({evt, bugname, finished, vendor: this.vendor}, 'Gather:_onTranscription raw transcript');
    if (bugname && this.bugname !== bugname) return;
    if (finished === 'true') return;

    if (this.vendor === 'ibm' && evt?.state === 'listening') return;
    if (this.vendor === 'deepgram' && evt.type === 'UtteranceEnd') {
      /* we will only get this when we have set utterance_end_ms */
      if (this._bufferedTranscripts.length === 0) {
        this.logger.debug('Gather:_onTranscription - got UtteranceEnd event from deepgram but no buffered transcripts');
      }
      else {
        this.logger.debug('Gather:_onTranscription - got UtteranceEnd event from deepgram, return buffered transcript');
        evt = this.consolidateTranscripts(this._bufferedTranscripts, 1, this.language, this.vendor);
        this._bufferedTranscripts = [];
        this._resolve('speech', evt);
      }
      return;
    }
    if (this.vendor === 'deepgram' && evt.type === 'Metadata') {
      this.logger.debug('Gather:_onTranscription - discarding Metadata event from deepgram');
      return;
    }

    evt = this.normalizeTranscription(evt, this.vendor, 1, this.language,
      this.shortUtterance, this.data.recognizer.punctuation);
    this.logger.debug({evt, bugname, finished, vendor: this.vendor}, 'Gather:_onTranscription normalized transcript');

    if (evt.alternatives.length === 0) {
      this.logger.info({evt}, 'TaskGather:_onTranscription - got empty transcript, continue listening');
      return;
    }
    const confidence = evt.alternatives[0].confidence;
    const minConfidence = this.data.recognizer?.minConfidence;
    this.logger.debug({evt},
      `TaskGather:_onTranscription - confidence (${confidence}), minConfidence (${minConfidence})`);
    if (confidence && minConfidence && confidence < minConfidence) {
      this.logger.info({evt},
        'TaskGather:_onTranscription - Transcript confidence ' +
        `(${confidence}) < minConfidence (${minConfidence})`);
      return this._resolve('stt-low-confidence', evt);
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

    let emptyTranscript = false;
    if (evt.is_final) {
      if (evt.alternatives[0].transcript === '' && !this.callSession.callGone && !this.killed) {
        emptyTranscript = true;
        if (finished === 'true' &&
          ['microsoft', 'deepgram'].includes(this.vendor) &&
          this._bufferedTranscripts.length === 0) {
          this.logger.debug({evt}, 'TaskGather:_onTranscription - got empty transcript from old gather, disregarding');
          return;
        }
        else if (this.vendor !== 'deepgram') {
          this.logger.info({evt}, 'TaskGather:_onTranscription - got empty transcript, continue listening');
          return;
        }
        else if (this.isContinuousAsr) {
          this.logger.info({evt},
            'TaskGather:_onTranscription - got empty deepgram transcript during continous asr, continue listening');
          return;
        }
        else if (this.vendor === 'deepgram' && this._bufferedTranscripts.length > 0) {
          this.logger.info({evt},
            'TaskGather:_onTranscription - got empty transcript from deepgram, return the buffered transcripts');
        }
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
        }
        this.logger.info({evt}, 'TaskGather:_onTranscription - got transcript during continous asr');
        this._bufferedTranscripts.push(evt);
        this._clearTimer();
        if (this._finalAsrTimer) {
          this._clearFinalAsrTimer();
          const evt = this.consolidateTranscripts(this._bufferedTranscripts, 1, this.language, this.vendor);
          return this._resolve(this._bufferedTranscripts.length > 0 ? 'speech' : 'timeout', evt);
        }
        this._startAsrTimer();

        /* some STT engines will keep listening after a final response, so no need to restart */
        if (!['soniox', 'aws', 'microsoft', 'deepgram', 'speechmatics'].includes(this.vendor) &&
          !this.vendor.startsWith('custom')) {
          this._startTranscribing(ep);
        }
      }
      else {
        /* this was removed to fix https://github.com/jambonz/jambonz-feature-server/issues/783 */
        /*
        if (this.bargein && (words + bufferedWords) < this.minBargeinWordCount) {
          this.logger.debug({evt, words, bufferedWords},
            'TaskGather:_onTranscription - final transcript but < min barge words');
          if (!emptyTranscript) this._bufferedTranscripts.push(evt);
          if (!['soniox', 'aws', 'microsoft', 'deepgram'].includes(this.vendor)) this._startTranscribing(ep);
          return;
        }
        else {
        */
        if (this.vendor === 'soniox') {
          /* compile transcripts into one */
          this._sonioxTranscripts.push(evt.vendor.finalWords);
          evt = this.compileSonioxTranscripts(this._sonioxTranscripts, 1, this.language);
          this._sonioxTranscripts = [];
        }
        else if (this.vendor === 'deepgram') {
          /* compile transcripts into one */
          if (!emptyTranscript) this._bufferedTranscripts.push(evt);

          /* deepgram can send an empty and final transcript; only if we have any buffered should we resolve */
          if (this._bufferedTranscripts.length === 0) return;
          evt = this.consolidateTranscripts(this._bufferedTranscripts, 1, this.language, this.vendor);
          this._bufferedTranscripts = [];
        }

        /* here is where we return a final transcript */
        this._resolve('speech', evt);
        /*}*/
      }
    }
    else {
      /* deepgram can send a non-final transcript but with words that are final, so we need to buffer */
      let emptyTranscript = false;
      if (this.vendor === 'deepgram') {
        const originalEvent = evt.vendor.evt;
        if (originalEvent.is_final && evt.alternatives[0].transcript !== '') {
          this.logger.debug({evt}, 'Gather:_onTranscription - buffering a completed (partial) deepgram transcript');
          this._bufferedTranscripts.push(evt);
        }
        if (evt.alternatives[0].transcript === '') emptyTranscript = true;
      }

      if (!emptyTranscript) {
        if (this._clearTimer()) this._startTimer();
        if (this.bargein && (words + bufferedWords) >= this.minBargeinWordCount) {
          if (!this.playComplete) {
            this.logger.debug({transcript: evt.alternatives[0].transcript}, 'killing audio due to speech');
            this.emit('vad');
            this.notifyStatus({event: 'speech-bargein-detected', ...evt});
          }
          this._killAudio(cs);
        }
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
        if (evt.vendor.finalWords.length) {
          this.logger.debug({evt}, 'TaskGather:_onTranscription - buffering soniox transcript');
          this._sonioxTranscripts.push(evt.vendor.finalWords);
        }
      }
      // If transcription received, reset timeout timer.
      if (this._timeoutTimer && !emptyTranscript) {
        this._startTimer();
      }
      /* restart asr timer if we get a partial transcript (only if the asr timer is already running) */
      /* note: https://github.com/jambonz/jambonz-feature-server/issues/866 */
      if (this.isContinuousAsr && this._asrTimer) this._startAsrTimer();
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
     * However, if the user has specified a singleUtterance, then we need to restart here
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

  async _startFallback(cs, ep, evt) {
    if (this.canFallback) {
      ep.stopTranscription({
        vendor: this.vendor,
        bugname: this.bugname
      })
        .catch((err) => this.logger.error({err}, `Error stopping transcription for primary vendor ${this.vendor}`));
      try {
        this.logger.debug('gather:_startFallback');
        this.notifyError({ msg: 'ASR error',
          details:`STT Vendor ${this.vendor} error: ${evt.error || evt.reason}`, failover: 'in progress'});
        await this._initFallback();
        this._speechHandlersSet = false;
        await this._setSpeechHandlers(cs, ep);
        this._startTranscribing(ep);
        return true;
      } catch (error) {
        this.logger.info({error}, `There is error while falling back to ${this.fallbackVendor}`);
        this.notifyError({ msg: 'ASR error',
          details:`STT Vendor ${this.vendor} error: ${evt.error || evt.reason}`, failover: 'not available'});
      }
    } else {
      this.logger.debug('gather:_startFallback no condition for falling back');
      this.notifyError({ msg: 'ASR error',
        details:`STT Vendor ${this.vendor} error: ${evt.error || evt.reason}`, failover: 'not available'});
    }
    return false;
  }

  async _onJambonzError(cs, ep, evt) {
    if (this.vendor === 'google' && evt.error_code === 0) {
      this.logger.info({evt}, 'TaskTranscribe:_onJambonzError - ignoring google error code 0');
      return;
    }
    this.logger.info({evt}, 'TaskGather:_onJambonzError');
    const {writeAlerts, AlertType} = cs.srf.locals;
    if (this.vendor === 'nuance') {
      const {code, error} = evt;
      if (code === 404 && error === 'No speech') return this._resolve('timeout');
      if (code === 413 && error === 'Too much speech') return this._resolve('timeout');
    }
    this.logger.info({evt}, 'TaskGather:_onJambonzError');
    const errMessage = evt.error || evt.Message;
    writeAlerts({
      account_sid: cs.accountSid,
      alert_type: AlertType.STT_FAILURE,
      message: `Custom speech vendor ${this.vendor} error: ${errMessage}`,
      vendor: this.vendor,
      target_sid: cs.callSid
    }).catch((err) => this.logger.info({err}, 'Error generating alert for jambonz custom connection failure'));
    if (!(await this._startFallback(cs, ep, evt))) {
      this.notifyTaskDone();
    }
  }

  async _onVendorConnectFailure(cs, _ep, evt) {
    super._onVendorConnectFailure(cs, _ep, evt);
    if (!(await this._startFallback(cs, _ep, evt))) {
      this.notifyTaskDone();
    }
  }

  async _onSpeechmaticsErrror(cs, _ep, evt) {
    // eslint-disable-next-line no-unused-vars
    const {message, ...e} = evt;
    this._onVendorError(cs, _ep, {error: JSON.stringify(e)});
  }

  async _onVendorError(cs, _ep, evt) {
    super._onVendorError(cs, _ep, evt);
    if (!(await this._startFallback(cs, _ep, evt))) {
      this._resolve('stt-error', evt);
    }
  }
  async _onSpeechmaticsRecognitionStarted(_cs, _ep, evt) {
    this.logger.debug({evt}, 'TaskGather:_onSpeechmaticsRecognitionStarted');
  }

  async _onSpeechmaticsInfo(_cs, _ep, evt) {
    this.logger.debug({evt}, 'TaskGather:_onSpeechmaticsInfo');
  }

  _onVadDetected(cs, ep) {
    if (this.bargein && this.minBargeinWordCount === 0) {
      this.logger.debug('TaskGather:_onVadDetected');
      this._killAudio(cs);
      this.emit('vad');
    }
    if (this.vad?.strategy === 'one-shot') {
      this.ep?.removeCustomEventListener(VadDetection.Detection, this._onVadDetected);
      this._vadStarted = false;
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
    if (this.needsStt && this.ep && this.ep.connected) {
      this.ep.stopTranscription({
        vendor: this.vendor,
        bugname: this.bugname
      })
        .catch((err) => {
          if (this.resolved) return;
          this.logger.error({err}, 'Error stopping transcription');
        });
    }
    if (this.resolved) {
      this.logger.debug('TaskGather:_resolve - already resolved');
      return;
    }

    this.resolved = true;
    // If bargin is false and ws application return ack to verb:hook
    // the gather should not play any audio
    this._killAudio(this.cs);
    // Clear dtmf events, to avoid any case can leak the listener, just clean it
    this.ep.removeAllListeners('dtmf');
    clearTimeout(this.interDigitTimer);
    this._clearTimer();
    this._clearFastRecognitionTimer();
    this._clearAsrTimer();
    this._clearFinalAsrTimer();

    this.span.setAttributes({
      channel: 1,
      'stt.label': this.label || 'None',
      'stt.resolve': reason,
      'stt.result': JSON.stringify(evt)
    });

    if (this.callSession && this.callSession.callGone) {
      this.logger.debug('TaskGather:_resolve - call is gone, not invoking web callback');
      this.notifyTaskDone();
      return;
    }

    // action hook delay
    if (this.cs.actionHookDelayProcessor) {
      this.logger.debug('TaskGather:_resolve - actionHookDelayProcessor exists - starting it');
      this.cs.actionHookDelayProcessor.start();
    }

    // TODO: remove and implement as actionHookDelay
    if (this.hasFillerNoise && (reason.startsWith('dtmf') || reason.startsWith('speech'))) {
      if (this.fillerNoiseStartDelaySecs > 0) {
        this._startFillerNoiseTimer();
      }
      else {
        this.logger.debug(`TaskGather:_resolve - playing filler noise: ${this.fillerNoiseUrl}`);
        this._startFillerNoise();
      }
    }

    let returnedVerbs = false;
    try {
      if (reason.startsWith('dtmf')) {
        if (this.parentTask) this.parentTask.emit('dtmf', evt);
        else {
          this.emit('dtmf', evt);
          returnedVerbs = await this.performAction({digits: this.digitBuffer, reason: 'dtmfDetected'});
        }
      }
      else if (reason.startsWith('speech')) {
        if (this.parentTask) this.parentTask.emit('transcription', evt);
        else {
          this.emit('transcription', evt);
          this.logger.debug('TaskGather:_resolve - invoking performAction');
          returnedVerbs = await this.performAction({speech: evt, reason: 'speechDetected'});
          this.logger.debug({returnedVerbs}, 'TaskGather:_resolve - back from performAction');
        }
      }
      else if (reason.startsWith('timeout')) {
        if (this.parentTask) this.parentTask.emit('timeout', evt);
        else {
          this.emit('timeout', evt);
          returnedVerbs = await this.performAction({reason: 'timeout'});
        }
      }
      else if (reason.startsWith('stt-error')) {
        if (this.parentTask) this.parentTask.emit('stt-error', evt);
        else {
          this.emit('stt-error', evt);
          returnedVerbs = await this.performAction({reason: 'error', details: evt.error});
        }
      } else if (reason.startsWith('stt-low-confidence')) {
        if (this.parentTask) this.parentTask.emit('stt-low-confidence', evt);
        else {
          this.emit('stt-low-confidence', evt);
          returnedVerbs = await this.performAction({reason: 'stt-low-confidence'});
        }
      }
    } catch (err) {  /*already logged error*/ }

    // Gather got response from hook, cancel actionHookDelay processing
    this.logger.debug('TaskGather:_resolve - checking ahd');
    if (this.cs.actionHookDelayProcessor) {
      if (returnedVerbs) {
        this.logger.debug('TaskGather:_resolve - got response from action hook, cancelling actionHookDelay');
        await this.cs.actionHookDelayProcessor.stop();
        if (this.actionHookDelayAction && !this.cs.popActionHookDelayProperties()) {
          // no session level ahd was running when this task started, so clear it
          this.cs.clearActionHookDelayProcessor();
          this.logger.debug('TaskGather:_resolve - clear ahd');
        }
      }
      else {
        this.logger.debug('TaskGather:_resolve - no response from action hook, continue actionHookDelay');
      }
    }

    this._clearFillerNoiseTimer();

    this.notifyTaskDone();
  }
}

module.exports = TaskGather;
