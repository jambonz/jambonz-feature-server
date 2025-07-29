const assert = require('assert');
const {
  TaskName,
  GoogleTranscriptionEvents,
  NuanceTranscriptionEvents,
  AwsTranscriptionEvents,
  AzureTranscriptionEvents,
  DeepgramTranscriptionEvents,
  DeepgramRiverTranscriptionEvents,
  SonioxTranscriptionEvents,
  CobaltTranscriptionEvents,
  IbmTranscriptionEvents,
  NvidiaTranscriptionEvents,
  JambonzTranscriptionEvents,
  TranscribeStatus,
  AssemblyAiTranscriptionEvents,
  VoxistTranscriptionEvents,
  CartesiaTranscriptionEvents,
  OpenAITranscriptionEvents,
  VerbioTranscriptionEvents,
  SpeechmaticsTranscriptionEvents
} = require('../utils/constants.json');
const { normalizeJambones } = require('@jambonz/verb-specifications');
const SttTask = require('./stt-task');
const { SpeechCredentialError } = require('../utils/error');

const STT_LISTEN_SPAN_NAME = 'stt-listen';

class TaskTranscribe extends SttTask {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);

    this.transcriptionHook = this.data.transcriptionHook;
    this.translationHook = this.data.translationHook;
    this.earlyMedia = this.data.earlyMedia === true || (parentTask && parentTask.earlyMedia);
    if (this.data.recognizer) {
      this.interim = !!this.data.recognizer.interim;
      this.separateRecognitionPerChannel = this.data.recognizer.separateRecognitionPerChannel;
    }

    /* for nested transcribe in dial, unless the app explicitly says so we want to transcribe both legs */
    if (this.parentTask?.name === TaskName.Dial) {
      if (this.data.channel === 1 || this.data.channel === 2) {
        /* transcribe only the channel specified */
        this.separateRecognitionPerChannel = false;
        this.channel = this.data.channel;
        logger.debug(`TaskTranscribe: transcribing only channel ${this.channel} in the Dial verb`);
      }
      else if (this.separateRecognitionPerChannel !== false) {
        this.separateRecognitionPerChannel = true;
      }
      else {
        this.channel = 1;
      }
    }
    else {
      this.channel = 1;
    }

    this.childSpan = [null, null];

    // Continuous asr timeout
    this.asrTimeout = typeof this.data.recognizer.asrTimeout === 'number' ? this.data.recognizer.asrTimeout * 1000 : 0;
    if (this.asrTimeout > 0) {
      this.isContinuousAsr = true;
    }
    /* buffer speech for continuous asr */
    this._bufferedTranscripts = [ [], [] ];  // for channel 1 and 2
    this.bugname_prefix = 'transcribe_';
    this.paused = false;
  }

  get name() { return TaskName.Transcribe; }

  get transcribing1() {
    return this.channel === 1 || this.separateRecognitionPerChannel;
  }

  get transcribing2() {
    return this.channel === 2 || this.separateRecognitionPerChannel && this.ep2;
  }

  async exec(cs, obj) {
    try {
      await this.handling(cs, obj);
    } catch (error) {
      if (error instanceof SpeechCredentialError) {
        this.logger.info('Transcribe failed due to SpeechCredentialError, finished!');
        this.notifyTaskDone();
        return;
      }
      throw error;
    }
  }

  async handling(cs, {ep, ep2}) {
    await super.exec(cs, {ep, ep2});

    if (this.data.recognizer.vendor === 'nuance') {
      this.data.recognizer.nuanceOptions = {
        // by default, nuance STT will recognize only 1st utterance.
        // enable multiple allow nuance detact all utterances
        utteranceDetectionMode: 'multiple',
        ...this.data.recognizer.nuanceOptions
      };
    }

    if (cs.hasGlobalSttHints) {
      const {hints, hintsBoost} = cs.globalSttHints;
      this.data.recognizer.hints = this.data.recognizer?.hints?.concat(hints);
      if (!this.data.recognizer.hintsBoost && hintsBoost) this.data.recognizer.hintsBoost = hintsBoost;
      this.logger.debug({hints: this.data.recognizer.hints, hintsBoost: this.data.recognizer.hintsBoost},
        'Transcribe:exec - applying global sttHints');
    }

    try {
      if (this.transcribing1) {
        await this._startTranscribing(cs, ep, 1);
      }
      if (this.transcribing2) {
        await this._startTranscribing(cs, ep2, 2);
      }
    } catch (err) {
      if (!(await this._startFallback(cs, ep, {error: err}))) {
        this.logger.info(err, 'TaskTranscribe:exec - error');
        this.parentTask && this.parentTask.emit('error', err);
        this.removeCustomEventListeners();
        return;
      }
    }
    await this.awaitTaskDone();
    this.removeCustomEventListeners();
  }

  async _stopTranscription() {
    let stopTranscription = false;
    if (this.transcribing1 && this.ep?.connected) {
      stopTranscription = true;
      this.ep.stopTranscription({
        vendor: this.vendor,
        bugname: this.bugname,
        gracefulShutdown: this.paused ? false : true
      })
        .catch((err) => this.logger.info(err, 'Error TaskTranscribe:kill'));
    }
    if (this.transcribing2 && this.ep2?.connected) {
      stopTranscription = true;
      this.ep2.stopTranscription({
        vendor: this.vendor,
        bugname: this.bugname,
        gracefulShutdown: this.paused ? false : true
      })
        .catch((err) => this.logger.info(err, 'Error TaskTranscribe:kill'));
    }

    this.cs.emit('transcribe-stop');

    return stopTranscription;
  }

  async kill(cs) {
    super.kill(cs);
    const stopTranscription = this._stopTranscription();
    cs.stopSttLatencyVad();
    // hangup after 1 sec if we don't get a final transcription
    if (stopTranscription) this._timer = setTimeout(() => this.notifyTaskDone(), 1500);
    else this.notifyTaskDone();

    await this.awaitTaskDone();
  }

  async updateTranscribe(status) {
    if (!this.killed && this.ep && this.ep.connected) {
      this.logger.info(`TaskTranscribe:updateTranscribe status ${status}`);
      switch (status) {
        case TranscribeStatus.Pause:
          this.paused = true;
          await this._stopTranscription();
          break;
        case TranscribeStatus.Resume:
          this.paused = false;
          if (this.transcribing1) await this._startTranscribing(this.cs, this.ep, 1);
          if (this.transcribing2) await this._startTranscribing(this.cs, this.ep2, 2);
          break;
      }
    }
  }

  async _setSpeechHandlers(cs, ep, channel) {
    if (this[`_speechHandlersSet_${channel}`]) return;
    this[`_speechHandlersSet_${channel}`] = true;

    /* some special deepgram logic */
    if (this.vendor === 'deepgram') {
      if (this.isContinuousAsr) this._doContinuousAsrWithDeepgram(this.asrTimeout);
    }

    const opts = this.setChannelVarsForStt(this, this.sttCredentials, this.language, this.data.recognizer);
    switch (this.vendor) {
      case 'google':
        this.bugname = `${this.bugname_prefix}google_transcribe`;
        this.addCustomEventListener(ep, GoogleTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        this.addCustomEventListener(ep, GoogleTranscriptionEvents.NoAudioDetected,
          this._onNoAudio.bind(this, cs, ep, channel));
        this.addCustomEventListener(ep, GoogleTranscriptionEvents.MaxDurationExceeded,
          this._onMaxDurationExceeded.bind(this, cs, ep, channel));
        break;

      case 'aws':
      case 'polly':
        this.bugname = `${this.bugname_prefix}aws_transcribe`;
        this.addCustomEventListener(ep, AwsTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        this.addCustomEventListener(ep, AwsTranscriptionEvents.NoAudioDetected,
          this._onNoAudio.bind(this, cs, ep, channel));
        this.addCustomEventListener(ep, AwsTranscriptionEvents.MaxDurationExceeded,
          this._onMaxDurationExceeded.bind(this, cs, ep, channel));
        break;
      case 'microsoft':
        this.bugname = `${this.bugname_prefix}azure_transcribe`;
        this.addCustomEventListener(ep, AzureTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        //this.addCustomEventListener(ep, AzureTranscriptionEvents.NoSpeechDetected,
        //  this._onNoAudio.bind(this, cs, ep, channel));
        break;
      case 'nuance':
        this.bugname = `${this.bugname_prefix}nuance_transcribe`;
        this.addCustomEventListener(ep, NuanceTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        break;
      case 'deepgram':
        this.bugname = `${this.bugname_prefix}deepgram_transcribe`;
        this.addCustomEventListener(ep, DeepgramTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        this.addCustomEventListener(ep, DeepgramTranscriptionEvents.Connect,
          this._onVendorConnect.bind(this, cs, ep));
        this.addCustomEventListener(ep, DeepgramTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep, channel));

        /* if app sets deepgramOptions.utteranceEndMs they essentially want continuous asr */
        //if (opts.DEEPGRAM_SPEECH_UTTERANCE_END_MS) this.isContinuousAsr = true;

        break;
      case 'deepgramriver':
        this.bugname = `${this.bugname_prefix}deepgramriver_transcribe`;
        this.addCustomEventListener(ep, DeepgramRiverTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        this.addCustomEventListener(ep, DeepgramRiverTranscriptionEvents.Connect,
          this._onVendorConnect.bind(this, cs, ep));
        this.addCustomEventListener(ep, DeepgramRiverTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep, channel));
        break;
      case 'soniox':
        this.bugname = `${this.bugname_prefix}soniox_transcribe`;
        this.addCustomEventListener(ep, SonioxTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        break;

      case 'verbio':
        this.bugname = `${this.bugname_prefix}verbio_transcribe`;
        this.addCustomEventListener(
          ep, VerbioTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
        break;

      case 'cobalt':
        this.bugname = `${this.bugname_prefix}cobalt_transcribe`;
        this.addCustomEventListener(ep, CobaltTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));

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
              opts.COBALT_SERVER_URI,
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
        break;

      case 'ibm':
        this.bugname = `${this.bugname_prefix}ibm_transcribe`;
        this.addCustomEventListener(ep, IbmTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        this.addCustomEventListener(ep, IbmTranscriptionEvents.Connect,
          this._onVendorConnect.bind(this, cs, ep));
        this.addCustomEventListener(ep, IbmTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep, channel));
        break;

      case 'nvidia':
        this.bugname = `${this.bugname_prefix}nvidia_transcribe`;
        this.addCustomEventListener(ep, NvidiaTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        break;

      case 'assemblyai':
        this.bugname = `${this.bugname_prefix}assemblyai_transcribe`;
        this.addCustomEventListener(ep, AssemblyAiTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        this.addCustomEventListener(ep,
          AssemblyAiTranscriptionEvents.Connect, this._onVendorConnect.bind(this, cs, ep));
        this.addCustomEventListener(ep, AssemblyAiTranscriptionEvents.Error, this._onVendorError.bind(this, cs, ep));
        this.addCustomEventListener(ep, AssemblyAiTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep, channel));
        break;

      case 'voxist':
        this.bugname = `${this.bugname_prefix}voxist_transcribe`;
        this.addCustomEventListener(ep, VoxistTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        this.addCustomEventListener(ep,
          VoxistTranscriptionEvents.Connect, this._onVendorConnect.bind(this, cs, ep));
        this.addCustomEventListener(ep, VoxistTranscriptionEvents.Error, this._onVendorError.bind(this, cs, ep));
        this.addCustomEventListener(ep, VoxistTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep, channel));
        break;

      case 'cartesia':
        this.bugname = `${this.bugname_prefix}cartesia_transcribe`;
        this.addCustomEventListener(ep, CartesiaTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        this.addCustomEventListener(ep,
          CartesiaTranscriptionEvents.Connect, this._onVendorConnect.bind(this, cs, ep));
        this.addCustomEventListener(ep, CartesiaTranscriptionEvents.Error, this._onVendorError.bind(this, cs, ep));
        this.addCustomEventListener(ep, CartesiaTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep, channel));
        break;

      case 'speechmatics':
        this.bugname = `${this.bugname_prefix}speechmatics_transcribe`;
        this.addCustomEventListener(
          ep, SpeechmaticsTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep, channel));
        this.addCustomEventListener(
          ep, SpeechmaticsTranscriptionEvents.Translation, this._onTranslation.bind(this, cs, ep, channel));
        this.addCustomEventListener(ep, SpeechmaticsTranscriptionEvents.Info,
          this._onSpeechmaticsInfo.bind(this, cs, ep));
        this.addCustomEventListener(ep, SpeechmaticsTranscriptionEvents.RecognitionStarted,
          this._onSpeechmaticsRecognitionStarted.bind(this, cs, ep));
        this.addCustomEventListener(ep, SpeechmaticsTranscriptionEvents.Connect,
          this._onVendorConnect.bind(this, cs, ep));
        this.addCustomEventListener(ep, SpeechmaticsTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep));
        this.addCustomEventListener(ep, SpeechmaticsTranscriptionEvents.Error,
          this._onSpeechmaticsError.bind(this, cs, ep));
        break;

      case 'openai':
        this.bugname = `${this.bugname_prefix}openai_transcribe`;
        this.addCustomEventListener(
          ep, OpenAITranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep, channel));
        this.addCustomEventListener(ep, OpenAITranscriptionEvents.Connect,
          this._onVendorConnect.bind(this, cs, ep));
        this.addCustomEventListener(ep, OpenAITranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep));
        this.addCustomEventListener(ep, OpenAITranscriptionEvents.Error,
          this._onOpenAIErrror.bind(this, cs, ep));

        this.modelSupportsConversationTracking = opts.OPENAI_MODEL !== 'whisper-1';
        break;

      default:
        if (this.vendor.startsWith('custom:')) {
          this.bugname = `${this.bugname_prefix}${this.vendor}_transcribe`;
          this.addCustomEventListener(ep, JambonzTranscriptionEvents.Transcription,
            this._onTranscription.bind(this, cs, ep, channel));
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

  async _startTranscribing(cs, ep, channel) {
    await this._setSpeechHandlers(cs, ep, channel);
    await this._transcribe(ep);

    /* start child span for this channel */
    const {span, ctx} = this.startChildSpan(`${STT_LISTEN_SPAN_NAME}:${channel}`);
    this.childSpan[channel - 1] = {span, ctx};
  }

  async _transcribe(ep) {
    this.logger.debug(
      `TaskTranscribe:_transcribe - starting transcription vendor ${this.vendor} bugname ${this.bugname}`);

    /* special feature for openai: we can provide a prompt that includes recent conversation history */
    let prompt;
    if (this.vendor === 'openai') {
      if (this.modelSupportsConversationTracking) {
        prompt = this.formatOpenAIPrompt(this.cs, {
          prompt: this.data.recognizer?.openaiOptions?.prompt,
          hintsTemplate: this.data.recognizer?.openaiOptions?.promptTemplates?.hintsTemplate,
          // eslint-disable-next-line max-len
          conversationHistoryTemplate: this.data.recognizer?.openaiOptions?.promptTemplates?.conversationHistoryTemplate,
          hints: this.data.recognizer?.hints,
        });
        this.logger.debug({prompt}, 'Gather:_startTranscribing - created an openai prompt');
      }
      else if (this.data.recognizer?.hints?.length > 0) {
        prompt = this.data.recognizer?.hints.join(', ');
      }
    }

    await ep.startTranscription({
      vendor: this.vendor,
      interim: this.interim ? true : false,
      locale: this.language,
      channels: 1,
      bugname: this.bugname,
      hostport: this.hostport
    });

    // Some vendor use single connection, that we cannot use onConnect event to track transcription start
    this.cs.emit('transcribe-start');
  }

  async _onTranscription(cs, ep, channel, evt, fsEvent) {
    // check if we are in graceful shutdown mode
    if (ep.gracefulShutdownResolver) {
      ep.gracefulShutdownResolver();
    }
    // make sure this is not a transcript from answering machine detection
    const bugname = fsEvent.getHeader('media-bugname');
    const finished = fsEvent.getHeader('transcription-session-finished');
    const bufferedTranscripts = this._bufferedTranscripts[channel - 1];
    if (bugname && this.bugname !== bugname) return;
    if (this.paused) {
      this.logger.debug({evt}, 'TaskTranscribe:_onTranscription - paused, ignoring transcript');
    }

    if (this.vendor === 'ibm' && evt?.state === 'listening') return;

    // emit an event to the call session to track the time transcription is received
    cs.emit('on-transcription');

    if (this.vendor === 'deepgram' && evt.type === 'UtteranceEnd') {
      /* we will only get this when we have set utterance_end_ms */

      /* DH: send a speech event when we get UtteranceEnd if they want interim events */
      if (this.interim) {
        this.logger.debug('Gather:_onTranscription - got UtteranceEnd event from deepgram, sending speech event');
        this._resolve(channel, evt);
      }
      if (bufferedTranscripts.length === 0) {
        this.logger.debug('Gather:_onTranscription - got UtteranceEnd event from deepgram but no buffered transcripts');
      }
      else {
        this.logger.debug('Gather:_onTranscription - got UtteranceEnd event from deepgram, return buffered transcript');
        evt = this.consolidateTranscripts(bufferedTranscripts, channel, this.language, this.vendor);
        evt.is_final = true;
        this._bufferedTranscripts[channel - 1] = [];
        this._resolve(channel, evt);
      }
      return;
    }
    this.logger.debug({evt}, 'TaskTranscribe:_onTranscription - before normalization');

    evt = this.normalizeTranscription(evt, this.vendor, channel, this.language, undefined,
      this.data.recognizer.punctuation);
    this.logger.debug({evt}, 'TaskTranscribe:_onTranscription');
    if (evt.alternatives.length === 0) {
      this.logger.info({evt}, 'TaskTranscribe:_onTranscription - got empty transcript, continue listening');
      return;
    }

    let emptyTranscript = false;
    if (evt.is_final) {
      if (evt.alternatives.length === 0 || evt.alternatives[0].transcript === '' && !cs.callGone && !this.killed) {
        emptyTranscript = true;
        if (finished === 'true' &&
          ['microsoft', 'deepgram'].includes(this.vendor) &&
          bufferedTranscripts.length === 0) {
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
        else if (this.vendor === 'deepgram' && bufferedTranscripts.length > 0) {
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
        bufferedTranscripts.push(evt);
        this._startAsrTimer(channel);

        /* some STT engines will keep listening after a final response, so no need to restart */
        if (!this.doesVendorContinueListeningAfterFinalTranscript(this.vendor)) {
          this._startTranscribing(cs, ep, channel);
        }
      }
      else {
        if (this.vendor === 'soniox') {
          /* compile transcripts into one */
          this._sonioxTranscripts.push(evt.vendor.finalWords);
          evt = this.compileSonioxTranscripts(this._sonioxTranscripts, 1, this.language);
          this._sonioxTranscripts = [];
        }
        else if (this.vendor === 'deepgram') {
          /* compile transcripts into one */
          if (!emptyTranscript) bufferedTranscripts.push(evt);

          /* deepgram can send an empty and final transcript; only if we have any buffered should we resolve */
          if (bufferedTranscripts.length === 0) return;
          evt = this.consolidateTranscripts(bufferedTranscripts, channel, this.language);
          this._bufferedTranscripts[channel - 1] = [];
        }

        /* here is where we return a final transcript */
        this.logger.debug({evt}, 'TaskTranscribe:_onTranscription - sending final transcript');
        this._resolve(channel, evt);

        if (!this.doesVendorContinueListeningAfterFinalTranscript(this.vendor)) {
          this.logger.debug('TaskTranscribe:_onTranscription - restarting transcribe');
          this._startTranscribing(cs, ep, channel);
        }
      }
    }
    else {
      /* interim transcript */

      /* deepgram can send a non-final transcript but with words that are final, so we need to buffer */
      if (this.vendor === 'deepgram') {
        const originalEvent = evt.vendor.evt;
        if (originalEvent.is_final && evt.alternatives[0].transcript !== '') {
          this.logger.debug({evt}, 'Gather:_onTranscription - buffering a completed (partial) deepgram transcript');
          bufferedTranscripts.push(evt);
        }
      }

      if (this.interim) {
        this.logger.debug({evt}, 'TaskTranscribe:_onTranscription - sending interim transcript');
        this._resolve(channel, evt);
      }
    }
  }

  async _onTranslation(_cs, _ep, channel, evt, _fsEvent) {
    this.logger.debug({evt}, 'TaskTranscribe:_onTranslation');
    if (this.translationHook && evt.results?.length > 0) {
      try {
        const b3 = this.getTracingPropagation();
        const httpHeaders = b3 && {b3};
        const payload = {
          ...this.cs.callInfo,
          ...httpHeaders,
          translation: {
            channel,
            language: evt.language,
            translation: evt.results[0].content
          }
        };

        this.logger.debug({payload}, 'sending translationHook');
        const json = await this.cs.requestor.request('verb:hook', this.translationHook, payload);
        this.logger.info({json}, 'completed translationHook');
        if (json && Array.isArray(json) && !this.parentTask) {
          const makeTask = require('./make_task');
          const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
          if (tasks && tasks.length > 0) {
            this.logger.info({tasks: tasks}, `${this.name} replacing application with ${tasks.length} tasks`);
            this.cs.replaceApplication(tasks);
          }
        }
      } catch (err) {
        this.logger.info(err, 'TranscribeTask:_onTranslation error');
      }
      if (this.parentTask) {
        this.parentTask.emit('translation', evt);
      }
    }
    if (this.killed) {
      this.logger.debug('TaskTranscribe:_onTranslation exiting after receiving final transcription');
      this._clearTimer();
      this.notifyTaskDone();
    }
  }

  async _resolve(channel, evt) {
    let sttLatencyMetrics = {};
    if (evt.is_final) {
      const sttLatency = this.cs.calculateSttLatency();
      if (sttLatency) {
        sttLatencyMetrics = {
          'stt.latency_ms': `${sttLatency.stt_latency_ms}`,
          'stt.talkspurts': JSON.stringify(sttLatency.talkspurts),
          'stt.start_time': sttLatency.stt_start_time,
          'stt.stop_time': sttLatency.stt_stop_time,
          'stt.usage': sttLatency.stt_usage,
        };
      }
      // time to reset the stt latency
      this.cs.emit('transcribe-start');
      /* we've got a final transcript, so end the otel child span for this channel */
      if (this.childSpan[channel - 1] && this.childSpan[channel - 1].span) {
        this.childSpan[channel - 1].span.setAttributes({
          channel,
          'stt.label': this.label || 'None',
          'stt.resolve': 'transcript',
          'stt.result': JSON.stringify(evt),
          ...sttLatencyMetrics
        });
        this.childSpan[channel - 1].span.end();
      }
    }

    if (this.transcriptionHook) {
      const b3 = this.getTracingPropagation();
      const httpHeaders = b3 && {b3};
      const latencies = Object.fromEntries(
        Object.entries(sttLatencyMetrics).map(([key, value]) => [key.replace('stt.', 'stt_'), value])
      );
      const payload = {
        ...this.cs.callInfo,
        ...httpHeaders,
        ...latencies,
        ...(evt.alternatives && {speech: evt}),
        ...(evt.type && {speechEvent: evt})
      };
      try {
        this.logger.debug({payload}, 'sending transcriptionHook');
        const json = await this.cs.requestor.request('verb:hook', this.transcriptionHook, payload);
        this.logger.info({json}, 'completed transcriptionHook');
        if (json && Array.isArray(json) && !this.parentTask) {
          const makeTask = require('./make_task');
          const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
          if (tasks && tasks.length > 0) {
            this.logger.info({tasks: tasks}, `${this.name} replacing application with ${tasks.length} tasks`);
            this.cs.replaceApplication(tasks);
          }
        }
      } catch (err) {
        this.logger.info(err, 'TranscribeTask:_onTranscription error');
      }
    }
    if (this.parentTask) {
      this.parentTask.emit('transcription', evt);
    }
    if (this.killed) {
      this.logger.debug('TaskTranscribe:_onTranscription exiting after receiving final transcription');
      this._clearTimer();
      this.notifyTaskDone();
    }
    else if (evt.is_final) {
      /* start another child span for this channel */
      const {span, ctx} = this.startChildSpan(`${STT_LISTEN_SPAN_NAME}:${channel}`);
      this.childSpan[channel - 1] = {span, ctx};
    }
  }

  _onNoAudio(cs, ep, channel) {
    this.logger.debug(`TaskTranscribe:_onNoAudio on channel ${channel}`);
    if (this.paused) return;
    if (this.childSpan[channel - 1] && this.childSpan[channel - 1].span) {
      this.childSpan[channel - 1].span.setAttributes({
        channel,
        'stt.resolve': 'timeout',
        'stt.label': this.label || 'None',
      });
      this.childSpan[channel - 1].span.end();
    }
    this._transcribe(ep);

    /* start new child span for this channel */
    const {span, ctx} = this.startChildSpan(`${STT_LISTEN_SPAN_NAME}:${channel}`);
    this.childSpan[channel - 1] = {span, ctx};
  }

  _onMaxDurationExceeded(cs, ep, channel) {
    this.restartDueToError(ep, channel, 'Max duration exceeded');
  }

  _onMaxBufferExceeded(cs, ep, channel) {
    this.restartDueToError(ep, channel, 'Max buffer exceeded');
  }

  restartDueToError(ep, channel, reason) {
    this.logger.debug(`TaskTranscribe:${reason} on channel ${channel}`);
    if (this.paused) return;

    if (this.childSpan[channel - 1] && this.childSpan[channel - 1].span) {
      this.childSpan[channel - 1].span.setAttributes({
        channel,
        'stt.resolve': reason,
        'stt.label': this.label || 'None',
      });
      this.childSpan[channel - 1].span.end();
    }

    this._transcribe(ep);

    /* start new child span for this channel */
    const {span, ctx} = this.startChildSpan(`${STT_LISTEN_SPAN_NAME}:${channel}`);
    this.childSpan[channel - 1] = {span, ctx};
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }

  async _startFallback(cs, _ep, evt) {
    if (this.canFallback) {
      _ep.stopTranscription({
        vendor: this.vendor,
        bugname: this.bugname,
        gracefulShutdown: false
      })
        .catch((err) => this.logger.error({err}, `Error stopping transcription for primary vendor ${this.vendor}`));
      try {
        this.notifyError({ msg: 'ASR error',
          details:`STT Vendor ${this.vendor} error: ${evt.error || evt.reason}`, failover: 'in progress'});
        await this._initFallback();
        let channel = 1;
        if (this.ep !== _ep) {
          channel = 2;
        }
        this[`_speechHandlersSet_${channel}`] = false;
        this._startTranscribing(cs, _ep, channel);
        return true;
      } catch (error) {
        this.notifyError({ msg: 'ASR error',
          details:`STT Vendor ${this.vendor} error: ${evt.error || evt.reason}`, failover: 'not available'});
        this.logger.info({error}, `There is error while falling back to ${this.fallbackVendor}`);
      }
    } else {
      this.logger.debug('transcribe:_startFallback no condition for falling back');
      this.notifyError({ msg: 'ASR error',
        details:`STT Vendor ${this.vendor} error: ${evt.error || evt.reason}`, failover: 'not available'});
    }
    return false;
  }

  async _onJambonzError(cs, _ep, evt) {
    if (this.vendor === 'google' && evt.error_code === 0) {
      this.logger.info({evt}, 'TaskTranscribe:_onJambonzError - ignoring google error code 0');
      return;
    }
    this.logger.info({evt}, 'TaskTranscribe:_onJambonzError');
    if (this.vendor === 'microsoft' &&
      evt.error?.includes('Due to service inactivity, the client buffer exceeded maximum size. Resetting the buffer')) {
      let channel = 1;
      if (this.ep !== _ep) {
        channel = 2;
      }
      return this._onMaxBufferExceeded(cs, _ep, channel);
    }
    if (this.paused) return;
    const {writeAlerts, AlertType} = cs.srf.locals;

    if (this.vendor === 'nuance') {
      const {code, error} = evt;
      if (code === 404 && error === 'No speech') return this._resolve('timeout');
      if (code === 413 && error === 'Too much speech') return this._resolve('timeout');
    }
    this.logger.info({evt}, 'TaskTranscribe:_onJambonzError');
    writeAlerts({
      account_sid: cs.accountSid,
      alert_type: AlertType.STT_FAILURE,
      message: `Custom speech vendor ${this.vendor} error: ${evt.error}`,
      vendor: this.vendor,
      target_sid: cs.callSid
    }).catch((err) => this.logger.info({err}, 'Error generating alert for jambonz custom connection failure'));
    if (!(await this._startFallback(cs, _ep, evt))) {
      this.notifyTaskDone();
    }
  }

  async _onVendorConnectFailure(cs, _ep, channel, evt) {
    super._onVendorConnectFailure(cs, _ep, evt);
    if (this.childSpan[channel - 1] && this.childSpan[channel - 1].span) {
      this.childSpan[channel - 1].span.setAttributes({
        channel,
        'stt.resolve': 'connection failure',
        'stt.label': this.label || 'None',
      });
      this.childSpan[channel - 1].span.end();
    }
    if (!(await this._startFallback(cs, _ep, evt))) {
      this.notifyTaskDone();
    }
  }

  async _onSpeechmaticsRecognitionStarted(_cs, _ep, evt) {
    this.logger.debug({evt}, 'TaskGather:_onSpeechmaticsRecognitionStarted');
  }

  async _onSpeechmaticsInfo(_cs, _ep, evt) {
    this.logger.debug({evt}, 'TaskGather:_onSpeechmaticsInfo');
  }

  async _onSpeechmaticsError(cs, _ep, evt) {
    // eslint-disable-next-line no-unused-vars
    const {message, ...e} = evt;
    this._onVendorError(cs, _ep, {error: JSON.stringify(e)});
  }

  async _onOpenAIErrror(cs, _ep, evt) {
    // eslint-disable-next-line no-unused-vars
    const {message, ...e} = evt;
    this._onVendorError(cs, _ep, {error: JSON.stringify(e)});
  }

  _startAsrTimer(channel) {
    if (this.vendor === 'deepgram') return; // no need
    assert(this.isContinuousAsr);
    this._clearAsrTimer(channel);
    this._asrTimer = setTimeout(() => {
      this.logger.debug(`TaskTranscribe:_startAsrTimer - asr timer went off for channel: ${channel}`);
      const evt = this.consolidateTranscripts(
        this._bufferedTranscripts[channel - 1], channel, this.language, this.vendor);
      this._bufferedTranscripts[channel - 1] = [];
      this._resolve(channel, evt);
    }, this.asrTimeout);
    this.logger.debug(`TaskTranscribe:_startAsrTimer: set for ${this.asrTimeout}ms for channel ${channel}`);
  }

  _clearAsrTimer(channel) {
    if (this._asrTimer) clearTimeout(this._asrTimer);
    this._asrTimer = null;
  }
}

module.exports = TaskTranscribe;
