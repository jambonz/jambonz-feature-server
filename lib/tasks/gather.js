const Task = require('./task');
const {
  TaskName,
  TaskPreconditions,
  GoogleTranscriptionEvents,
  NuanceTranscriptionEvents,
  AwsTranscriptionEvents,
  AzureTranscriptionEvents
} = require('../utils/constants');

const makeTask = require('./make_task');
const assert = require('assert');

const compileTranscripts = (logger, evt, arr) => {
  //logger.debug({arr, evt}, 'compile transcripts');
  if (!Array.isArray(arr) || arr.length === 0) return;
  let t = '';
  for (const a of arr) {
    //logger.debug(`adding ${a.alternatives[0].transcript}`);
    t += ` ${a.alternatives[0].transcript}`;
  }
  t += ` ${evt.alternatives[0].transcript}`;
  evt.alternatives[0].transcript = t.trim();
  //logger.debug(`compiled transcript: ${evt.alternatives[0].transcript}`);
};

class TaskGather extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    const {setChannelVarsForStt, normalizeTranscription} = require('../utils/transcription-utils')(logger);
    this.setChannelVarsForStt = setChannelVarsForStt;
    this.normalizeTranscription = normalizeTranscription;

    [
      'finishOnKey', 'hints', 'input', 'numDigits', 'minDigits', 'maxDigits',
      'interDigitTimeout', 'partialResultHook', 'bargein', 'dtmfBargein',
      'speechTimeout', 'timeout', 'say', 'play'
    ].forEach((k) => this[k] = this.data[k]);

    /* when collecting dtmf, bargein on dtmf is true unless explicitly set to false */
    if (this.dtmfBargein !== false  && this.input.includes('digits')) this.dtmfBargein = true;

    /* timeout of zero means no timeout */
    this.timeout = this.timeout === 0 ? 0 : (this.timeout || 15) * 1000;
    this.interim = !!this.partialResultHook || this.bargein;
    this.listenDuringPrompt = this.data.listenDuringPrompt === false ? false : true;
    this.minBargeinWordCount = this.data.minBargeinWordCount || 0;
    if (this.data.recognizer) {
      const recognizer = this.data.recognizer;
      this.vendor = recognizer.vendor;
      this.language = recognizer.language;

      /* continuous ASR (i.e. compile transcripts until a special timeout or dtmf key) */
      this.asrTimeout = typeof recognizer.asrTimeout === 'number' ? recognizer.asrTimeout * 1000 : 0;
      if (this.asrTimeout > 0) this.asrDtmfTerminationDigit = recognizer.asrDtmfTerminationDigit;
      this.isContinuousAsr = this.asrTimeout > 0;

      this.data.recognizer.hints = this.data.recognizer.hints || [];
      this.data.recognizer.altLanguages = this.data.recognizer.altLanguages || [];
    }
    else this.data.recgnizer = {hints: [], altLanguages: []};

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

    this.parentTask = parentTask;
  }

  get name() { return TaskName.Gather; }

  get needsStt() { return this.input.includes('speech'); }

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
    this.logger.debug('Gather:exec');
    await super.exec(cs);
    const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, cs.srf);
    const {getNuanceAccessToken} = cs.srf.locals.dbHelpers;

    if (cs.hasGlobalSttHints) {
      const {hints, hintsBoost} = cs.globalSttHints;
      this.data.recognizer.hints = this.data.recognizer.hints.concat(hints);
      if (!this.data.recognizer.hintsBoost && hintsBoost) this.data.recognizer.hintsBoost = hintsBoost;
      this.logger.debug({hints: this.data.recognizer.hints, hintsBoost: this.data.recognizer.hintsBoost},
        'Gather:exec - applying global sttHints');
    }
    if (cs.hasAltLanguages) {
      this.data.recognizer.altLanguages = this.data.recognizer.altLanguages.concat(cs.altLanguages);
      this.logger.debug({altLanguages: this.altLanguages},
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
    this.ep = ep;
    if ('default' === this.vendor || !this.vendor) this.vendor = cs.speechRecognizerVendor;
    if ('default' === this.language || !this.language) this.language = cs.speechRecognizerLanguage;

    if (!this.sttCredentials) this.sttCredentials = cs.getSpeechCredentials(this.vendor, 'stt');
    if (this.needsStt && !this.sttCredentials) {
      const {writeAlerts, AlertType} = cs.srf.locals;
      this.logger.info(`TaskGather:exec - ERROR stt using ${this.vendor} requested but creds not supplied`);
      writeAlerts({
        account_sid: cs.accountSid,
        alert_type: AlertType.STT_NOT_PROVISIONED,
        vendor: this.vendor
      }).catch((err) => this.logger.info({err}, 'Error generating alert for no stt'));

      throw new Error(`no speech-to-text service credentials for ${this.vendor} have been configured`);
    }

    if (this.vendor === 'nuance') {
      /* get nuance access token */
      const {clientId, secret} = this.sttCredentials;
      const {access_token, servedFromCache} = await getNuanceAccessToken(clientId, secret, 'asr tts');
      this.logger.debug({clientId}, `Gather:exec - got nuance access token ${servedFromCache ? 'from cache' : ''}`);
      this.sttCredentials = {...this.sttCredentials, access_token};
    }
    const startListening = (cs, ep) => {
      this._startTimer();
      if (this.isContinuousAsr && 0 === this.timeout) this._startAsrTimer();
      if (this.input.includes('speech') && !this.listenDuringPrompt) {
        this.logger.debug('Gather:exec - calling _initSpeech');
        this._initSpeech(cs, ep)
          .then(() => {
            this._startTranscribing(ep);
            return updateSpeechCredentialLastUsed(this.sttCredentials.speech_credential_sid);
          })
          .catch((err) => {
            this.logger.error({err}, 'error in initSpeech');
          });
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
          if (!this.killed) startListening(cs, ep);
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
          if (!this.killed) startListening(cs, ep);
        });
      }
      else startListening(cs, ep);

      if (this.input.includes('speech') && this.listenDuringPrompt) {
        await this._initSpeech(cs, ep);
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
    ep.removeCustomEventListener(GoogleTranscriptionEvents.VadDetected);
  }

  kill(cs) {
    super.kill(cs);
    this._killAudio(cs);
    this.ep.removeAllListeners('dtmf');
    clearTimeout(this.interDigitTimer);
    this.playTask?.span.end();
    this.sayTask?.span.end();
    this._resolve('killed');
  }

  updateTimeout(timeout) {
    this.logger.info(`TaskGather:updateTimeout - updating timeout to ${timeout}`);
    this.timeout = timeout;
    this._startTimer();
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

  async _initSpeech(cs, ep) {
    const opts = this.setChannelVarsForStt(this, this.sttCredentials, this.data.recognizer);
    this.logger.debug(opts, 'TaskGather:_initSpeech - channel vars');
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
        ep.addCustomEventListener(AzureTranscriptionEvents.VadDetected,
          this._onVadDetected.bind(this, cs, ep));
        ep.addCustomEventListener(AzureTranscriptionEvents.Error,
          this._onNuanceError.bind(this, cs, ep));
        break;
      default:
        throw new Error(`Invalid vendor ${this.vendor}`);
    }

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
    this.logger.debug({evt}, 'Gather:_onTranscription');
    const bugname = fsEvent.getHeader('media-bugname');
    const finished = fsEvent.getHeader('transcription-session-finished');
    if (bugname && this.bugname !== bugname) return;

    evt = this.normalizeTranscription(evt, this.vendor, 1, this.language);

    /* count words for bargein feature */
    const words = evt.alternatives[0].transcript.split(' ').length;
    const bufferedWords = this._bufferedTranscripts.reduce((count, e) => {
      return count + e.alternatives[0].transcript.split(' ').length;
    }, 0);

    if (evt.is_final) {
      if (evt.alternatives[0].transcript === '' && !this.callSession.callGone && !this.killed) {
        if ('microsoft' === this.vendor && finished === 'true') {
          this.logger.debug({evt}, 'TaskGather:_onTranscription - got empty transcript from old gather, disregarding');
        }
        else {
          this.logger.info({evt}, 'TaskGather:_onTranscription - got empty transcript, listen again');
          this._startTranscribing(ep);
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
        return this._startTranscribing(ep);
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
      if (this.bargein && (words + bufferedWords) >= this.minBargeinWordCount) {
        if (!this.playComplete) {
          this.logger.debug({transcript: evt.alternatives[0].transcript}, 'killing audio due to speech');
          this.emit('vad');
        }
        this._killAudio(cs);
      }
      if (this.partialResultHook) {
        const b3 = this.getTracingPropagation();
        const httpHeaders = b3 && {b3};
        this.cs.requestor.request('verb:hook', this.partialResultHook,  Object.assign({speech: evt},
          this.cs.callInfo, httpHeaders));
      }
    }
  }
  _onEndOfUtterance(cs, ep) {
    this.logger.debug('TaskGather:_onEndOfUtterance');
    if (this.bargein && this.minBargeinWordCount === 0) {
      this._killAudio(cs);
    }

    if (!this.resolved && !this.killed && !this._bufferedTranscripts.length) {
      this._startTranscribing(ep);
    }
  }

  _onStartOfSpeech(cs, ep) {
    this.logger.debug('TaskGather:_onStartOfSpeech');
  }
  _onTranscriptionComplete(cs, ep) {
    this.logger.debug('TaskGather:_onTranscriptionComplete');
  }
  _onNuanceError(cs, ep) {
    this.logger.debug('TaskGather:_onNuanceError');
  }

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
    clearTimeout(this.interDigitTimer);
    this._clearTimer();

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

    this.span.setAttributes({'stt.resolve': reason, 'stt.result': JSON.stringify(evt)});
    if (this.needsStt && this.ep && this.ep.connected) {
      this.ep.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.error({err}, 'Error stopping transcription'));
    }

    if (this.callSession && this.callSession.callGone) {
      this.logger.debug('TaskGather:_resolve - call is gone, not invoking web callback');
      this.notifyTaskDone();
      return;
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
    this.notifyTaskDone();
  }
}

module.exports = TaskGather;
