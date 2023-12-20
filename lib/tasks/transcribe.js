const assert = require('assert');
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
  TranscribeStatus,
  AssemblyAiTranscriptionEvents
} = require('../utils/constants.json');
const { normalizeJambones } = require('@jambonz/verb-specifications');
const SttTask = require('./stt-task');

const STT_LISTEN_SPAN_NAME = 'stt-listen';

class TaskTranscribe extends SttTask {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);

    this.transcriptionHook = this.data.transcriptionHook;
    this.earlyMedia = this.data.earlyMedia === true || (parentTask && parentTask.earlyMedia);

    if (this.data.recognizer) {
      this.interim = !!this.data.recognizer.interim;
      this.separateRecognitionPerChannel = this.data.recognizer.separateRecognitionPerChannel;
    }

    if (this.data.recognizer.vendor === 'nuance') {
      this.data.recognizer.nuanceOptions = {
        // by default, nuance STT will recognize only 1st utterance.
        // enable multiple allow nuance detact all utterances
        utteranceDetectionMode: 'multiple',
        ...this.data.recognizer.nuanceOptions
      };
    }

    this.childSpan = [null, null];

    // Continuos asr timeout
    this.asrTimeout = typeof this.data.recognizer.asrTimeout === 'number' ? this.data.recognizer.asrTimeout * 1000 : 0;
    if (this.asrTimeout > 0) {
      this.isContinuousAsr = true;
    }
    /* buffer speech for continuous asr */
    this._bufferedTranscripts = [];
  }

  get name() { return TaskName.Transcribe; }

  async exec(cs, {ep, ep2}) {
    await super.exec(cs, {ep, ep2});
    const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, cs.srf);

    if (cs.hasGlobalSttHints) {
      const {hints, hintsBoost} = cs.globalSttHints;
      this.data.recognizer.hints = this.data.recognizer.hints.concat(hints);
      if (!this.data.recognizer.hintsBoost && hintsBoost) this.data.recognizer.hintsBoost = hintsBoost;
      this.logger.debug({hints: this.data.recognizer.hints, hintsBoost: this.data.recognizer.hintsBoost},
        'Transcribe:exec - applying global sttHints');
    }
    if (cs.hasAltLanguages) {
      this.data.recognizer.altLanguages = this.data.recognizer.altLanguages.concat(cs.altLanguages);
      this.logger.debug({altLanguages: this.altLanguages},
        'Transcribe:exec - applying altLanguages');
    }
    if (cs.hasGlobalSttPunctuation && !this.data.recognizer.punctuation) {
      this.data.recognizer.punctuation = cs.globalSttPunctuation;
    }
    try {
      await this._startTranscribing(cs, ep, 1);
      if (this.separateRecognitionPerChannel && ep2) {
        await this._startTranscribing(cs, ep2, 2);
      }

      updateSpeechCredentialLastUsed(this.sttCredentials.speech_credential_sid)
        .catch(() => {/*already logged error */});

      await this.awaitTaskDone();
    } catch (err) {
      this.logger.info(err, 'TaskTranscribe:exec - error');
      this.parentTask && this.parentTask.emit('error', err);
    }
    this.removeSpeechListeners(ep);
  }

  async _stopTranscription() {
    let stopTranscription = false;
    if (this.ep?.connected) {
      stopTranscription = true;
      this.ep.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.info(err, 'Error TaskTranscribe:kill'));
    }
    if (this.separateRecognitionPerChannel && this.ep2 && this.ep2.connected) {
      stopTranscription = true;
      this.ep2.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.info(err, 'Error TaskTranscribe:kill'));
    }

    return stopTranscription;
  }

  async kill(cs) {
    super.kill(cs);
    const stopTranscription = this._stopTranscription();
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
          await this._stopTranscription();
          break;
        case TranscribeStatus.Resume:
          await this._startTranscribing(this.cs, this.ep, 1);
          if (this.separateRecognitionPerChannel && this.ep2) {
            await this._startTranscribing(this.cs, this.ep2, 2);
          }
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

    const opts = this.setChannelVarsForStt(this, this.sttCredentials, this.data.recognizer);
    switch (this.vendor) {
      case 'google':
        this.bugname = 'google_transcribe';
        ep.addCustomEventListener(GoogleTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        ep.addCustomEventListener(GoogleTranscriptionEvents.NoAudioDetected,
          this._onNoAudio.bind(this, cs, ep, channel));
        ep.addCustomEventListener(GoogleTranscriptionEvents.MaxDurationExceeded,
          this._onMaxDurationExceeded.bind(this, cs, ep, channel));
        break;

      case 'aws':
      case 'polly':
        this.bugname = 'aws_transcribe';
        ep.addCustomEventListener(AwsTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        ep.addCustomEventListener(AwsTranscriptionEvents.NoAudioDetected,
          this._onNoAudio.bind(this, cs, ep, channel));
        ep.addCustomEventListener(AwsTranscriptionEvents.MaxDurationExceeded,
          this._onMaxDurationExceeded.bind(this, cs, ep, channel));
        break;
      case 'microsoft':
        this.bugname = 'azure_transcribe';
        ep.addCustomEventListener(AzureTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        ep.addCustomEventListener(AzureTranscriptionEvents.NoSpeechDetected,
          this._onNoAudio.bind(this, cs, ep, channel));
        break;
      case 'nuance':
        this.bugname = 'nuance_transcribe';
        ep.addCustomEventListener(NuanceTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        break;
      case 'deepgram':
        this.bugname = 'deepgram_transcribe';
        ep.addCustomEventListener(DeepgramTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        ep.addCustomEventListener(DeepgramTranscriptionEvents.Connect,
          this._onVendorConnect.bind(this, cs, ep));
        ep.addCustomEventListener(DeepgramTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep, channel));

        /* if app sets deepgramOptions.utteranceEndMs they essentially want continuous asr */
        if (opts.DEEPGRAM_SPEECH_UTTERANCE_END_MS) this.isContinuousAsr = true;

        break;
      case 'soniox':
        this.bugname = 'soniox_transcribe';
        ep.addCustomEventListener(SonioxTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        break;
      case 'cobalt':
        this.bugname = 'cobalt_transcribe';
        ep.addCustomEventListener(CobaltTranscriptionEvents.Transcription,
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
        this.bugname = 'ibm_transcribe';
        ep.addCustomEventListener(IbmTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        ep.addCustomEventListener(IbmTranscriptionEvents.Connect,
          this._onVendorConnect.bind(this, cs, ep));
        ep.addCustomEventListener(IbmTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep, channel));
        break;

      case 'nvidia':
        this.bugname = 'nvidia_transcribe';
        ep.addCustomEventListener(NvidiaTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        break;

      case 'assemblyai':
        this.bugname = 'assemblyai_transcribe';
        ep.addCustomEventListener(AssemblyAiTranscriptionEvents.Transcription,
          this._onTranscription.bind(this, cs, ep, channel));
        ep.addCustomEventListener(AssemblyAiTranscriptionEvents.Connect, this._onVendorConnect.bind(this, cs, ep));
        ep.addCustomEventListener(AssemblyAiTranscriptionEvents.Error, this._onVendorError.bind(this, cs, ep));
        ep.addCustomEventListener(AssemblyAiTranscriptionEvents.ConnectFailure,
          this._onVendorConnectFailure.bind(this, cs, ep, channel));
        break;

      default:
        if (this.vendor.startsWith('custom:')) {
          this.bugname = `${this.vendor}_transcribe`;
          ep.addCustomEventListener(JambonzTranscriptionEvents.Transcription,
            this._onTranscription.bind(this, cs, ep, channel));
          ep.addCustomEventListener(JambonzTranscriptionEvents.Connect, this._onVendorConnect.bind(this, cs, ep));
          ep.addCustomEventListener(JambonzTranscriptionEvents.ConnectFailure,
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
    ep.addCustomEventListener(JambonzTranscriptionEvents.Error, this._onJambonzError.bind(this, cs, ep));
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
    await ep.startTranscription({
      vendor: this.vendor,
      interim: this.interim ? true : false,
      locale: this.language,
      channels: /*this.separateRecognitionPerChannel ? 2 : */ 1,
      bugname: this.bugname,
      hostport: this.hostport
    });
  }

  async _onTranscription(cs, ep, channel, evt, fsEvent) {
    // make sure this is not a transcript from answering machine detection
    const bugname = fsEvent.getHeader('media-bugname');
    if (bugname && this.bugname !== bugname) return;

    if (this.vendor === 'ibm' && evt?.state === 'listening') return;

    if (this.vendor === 'deepgram' && evt.type === 'UtteranceEnd') {
      /* we will only get this when we have set utterance_end_ms */
      if (this._bufferedTranscripts.length === 0) {
        this.logger.debug('Gather:_onTranscription - got UtteranceEnd event from deepgram but no buffered transcripts');
      }
      else {
        this.logger.debug('Gather:_onTranscription - got UtteranceEnd event from deepgram, return buffered transcript');
        evt = this.consolidateTranscripts(this._bufferedTranscripts, 1, this.language);
        this._bufferedTranscripts = [];
        this._resolve('speech', evt);
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

    if (evt.alternatives[0]?.transcript === '' && !cs.callGone && !this.killed) {
      if (['microsoft', 'deepgram'].includes(this.vendor)) {
        this.logger.info({evt}, 'TaskTranscribe:_onTranscription - got empty transcript, continue listening');
      }
      else {
        this.logger.info({evt}, 'TaskTranscribe:_onTranscription - got empty transcript, listen again');
        this._transcribe(ep);
      }
      return;
    }

    if (this.vendor === 'soniox') {
      /* compile transcripts into one */
      this._sonioxTranscripts.push(evt.vendor.finalWords);
      if (evt.is_final) {
        evt = this.compileSonioxTranscripts(this._sonioxTranscripts, 1, this.language);
        this._sonioxTranscripts = [];
      }
    }

    if (this.isContinuousAsr && evt.is_final) {
      this._bufferedTranscripts.push(evt);
      this._startAsrTimer(channel);
    } else {
      await this._resolve(channel, evt);
    }
  }

  async _resolve(channel, evt) {
    /* we've got a transcript, so end the otel child span for this channel */
    if (this.childSpan[channel - 1] && this.childSpan[channel - 1].span) {
      this.childSpan[channel - 1].span.setAttributes({
        channel,
        'stt.resolve': 'transcript',
        'stt.result': JSON.stringify(evt)
      });
      this.childSpan[channel - 1].span.end();
    }

    if (this.transcriptionHook) {
      const b3 = this.getTracingPropagation();
      const httpHeaders = b3 && {b3};
      try {
        const json = await this.cs.requestor.request('verb:hook', this.transcriptionHook, {
          ...this.cs.callInfo,
          ...httpHeaders,
          speech: evt
        });
        this.logger.info({json}, 'sent transcriptionHook');
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
    else {
      /* start another child span for this channel */
      const {span, ctx} = this.startChildSpan(`${STT_LISTEN_SPAN_NAME}:${channel}`);
      this.childSpan[channel - 1] = {span, ctx};
    }
  }

  _onNoAudio(cs, ep, channel) {
    this.logger.debug(`TaskTranscribe:_onNoAudio restarting transcription on channel ${channel}`);
    if (this.childSpan[channel - 1] && this.childSpan[channel - 1].span) {
      this.childSpan[channel - 1].span.setAttributes({
        channel,
        'stt.resolve': 'timeout'
      });
      this.childSpan[channel - 1].span.end();
    }
    this._transcribe(ep);

    /* start new child span for this channel */
    const {span, ctx} = this.startChildSpan(`${STT_LISTEN_SPAN_NAME}:${channel}`);
    this.childSpan[channel - 1] = {span, ctx};
  }

  _onMaxDurationExceeded(cs, ep, channel) {
    this.logger.debug(`TaskTranscribe:_onMaxDurationExceeded restarting transcription on channel ${channel}`);
    if (this.childSpan[channel - 1] && this.childSpan[channel - 1].span) {
      this.childSpan[channel - 1].span.setAttributes({
        channel,
        'stt.resolve': 'max duration exceeded'
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

  async _onJambonzError(cs, _ep, evt) {
    this.logger.info({evt}, 'TaskTranscribe:_onJambonzError');
    if (this.isHandledByPrimaryProvider && this.fallbackVendor) {
      _ep.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.error({err}, `Error stopping transcription for primary vendor ${this.vendor}`));
      const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, cs.srf);
      try {
        await this._fallback();
        let channel = 1;
        if (this.ep !== _ep) {
          channel = 2;
        }
        this._startTranscribing(cs, _ep, channel);
        updateSpeechCredentialLastUsed(this.sttCredentials.speech_credential_sid);
        return;
      } catch (error) {
        this.logger.info({error}, `There is error while falling back to ${this.fallbackVendor}`);
      }
    } else {
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
      }).catch((err) => this.logger.info({err}, 'Error generating alert for jambonz custom connection failure'));
      this.notifyError({msg: 'ASR error', details:`Custom speech vendor ${this.vendor} error: ${evt.error}`});
    }
  }

  _onVendorConnectFailure(cs, _ep, channel, evt) {
    super._onVendorConnectFailure(cs, _ep, evt);
    if (this.childSpan[channel - 1] && this.childSpan[channel - 1].span) {
      this.childSpan[channel - 1].span.setAttributes({
        channel,
        'stt.resolve': 'connection failure'
      });
      this.childSpan[channel - 1].span.end();
    }
    this.notifyTaskDone();
  }

  _startAsrTimer(channel) {
    if (this.vendor === 'deepgram') return; // no need
    assert(this.isContinuousAsr);
    this._clearAsrTimer(channel);
    this._asrTimer = setTimeout(() => {
      this.logger.debug(`TaskTranscribe:_startAsrTimer - asr timer went off for channel: ${channel}`);
      const evt = this.consolidateTranscripts(this._bufferedTranscripts, channel, this.language);
      this._bufferedTranscripts = [];
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
