const Task = require('./task');
const {
  TaskName,
  TaskPreconditions,
  GoogleTranscriptionEvents,
  AwsTranscriptionEvents,
  AzureTranscriptionEvents
} = require('../utils/constants');

const makeTask = require('./make_task');
const assert = require('assert');

const GATHER_STABILITY_THRESHOLD =  Number(process.env.JAMBONZ_GATHER_STABILITY_THRESHOLD || 0.7); 

class TaskGather extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    [
      'finishOnKey', 'hints', 'input', 'numDigits', 'minDigits', 'maxDigits',
      'interDigitTimeout', 'submitDigit', 'partialResultHook', 'bargein', 'dtmfBargein',
      'retries', 'retryPromptTts', 'retryPromptUrl',
      'speechTimeout', 'timeout', 'say', 'play'
    ].forEach((k) => this[k] = this.data[k]);
    this.listenDuringPrompt = this.data.listenDuringPrompt === false ? false : true;
    this.minBargeinWordCount = this.data.minBargeinWordCount || 1;

    this.logger.debug({opts}, 'created gather task');
    this.timeout = (this.timeout || 15) * 1000;
    this.interim = this.partialResultCallback || this.bargein;
    if (this.data.recognizer) {
      const recognizer = this.data.recognizer;
      this.vendor = recognizer.vendor;
      this.language = recognizer.language;
      this.hints = recognizer.hints || [];
      this.altLanguages = recognizer.altLanguages || [];

      /* aws options */
      this.vocabularyName = recognizer.vocabularyName;
      this.vocabularyFilterName = recognizer.vocabularyFilterName;
      this.filterMethod = recognizer.filterMethod;

      /* microsoft options */
      this.outputFormat = recognizer.outputFormat || 'simple';
      this.profanityOption = recognizer.profanityOption || 'raw';
      this.requestSnr = recognizer.requestSnr || false;
      this.initialSpeechTimeoutMs = recognizer.initialSpeechTimeoutMs || 0;
    }

    this.digitBuffer = '';
    this._earlyMedia = this.data.earlyMedia === true;

    if (this.say) this.sayTask = makeTask(this.logger, {say: this.say}, this);
    if (this.play) this.playTask = makeTask(this.logger, {play: this.play}, this);

    if(this.sayTask || this.playTask){
        // this is specially for barge in where we want to make a bargebale promt
        // to a user without listening after the say task has finished
        this.listenAfterSpeech = typeof this.data.listenAfterSpeech === "boolean" ? this.data.listenAfterSpeech : true;
    }

    this.parentTask = parentTask;
  }

  get name() { return TaskName.Gather; }

  get needsStt() { return this.input.includes('speech'); }

  get earlyMedia() {
    return (this.sayTask && this.sayTask.earlyMedia) ||
      (this.playTask && this.playTask.earlyMedia);
  }

  async exec(cs, ep) {
    await super.exec(cs);
    const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, cs.srf);

    this.ep = ep;
    if ('default' === this.vendor || !this.vendor) this.vendor = cs.speechRecognizerVendor;
    if ('default' === this.language || !this.language) this.language = cs.speechRecognizerLanguage;
    this.sttCredentials = cs.getSpeechCredentials(this.vendor, 'stt');
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

    const startListening = (cs, ep) => {
      this._startTimer();
      if (this.input.includes('speech') && !this.listenDuringPrompt) {
        this._initSpeech(cs, ep)
          .then(() => {
            this._startTranscribing(ep);
            return updateSpeechCredentialLastUsed(this.sttCredentials.speech_credential_sid);
          })
          .catch(() => {});
      }
    };

    try {
      if (this.sayTask) {
        this.logger.debug('Gather: kicking off say task');
        this.sayTask.exec(cs, ep);
        this.sayTask.on('playDone', async(err) => {
          if (err) return this.logger.error({err}, 'Gather:exec Error playing tts');
          this.logger.debug('Gather: say task completed');
          if (!this.killed) {
            if (this.listenAfterSpeech === true) {
              startListening(cs, ep);
            } else {
              this.notifyTaskDone();
            }
          }
        });
      }
      else if (this.playTask) {
        this.playTask.exec(cs, ep);  // kicked off, _not_ waiting for it to complete
        this.playTask.on('playDone', async(err) => {
          if (err) return this.logger.error({err}, 'Gather:exec Error playing url');
          if (!this.killed) {
            if (this.listenAfterSpeech === true) {
              startListening(cs, ep);
            } else {
              this.notifyTaskDone();
            }
          }
        }
        );
      }
      else startListening(cs, ep);

      if (this.input.includes('speech') && this.listenDuringPrompt) {
        await this._initSpeech(cs, ep);
        this._startTranscribing(ep);
        updateSpeechCredentialLastUsed(this.sttCredentials.speech_credential_sid)
          .catch(() => {/*already logged error */});
      }

      if (this.input.includes('digits') || this.dtmfBargein) {
        ep.on('dtmf', this._onDtmf.bind(this, cs, ep));
      }

      await this.awaitTaskDone();
      this.logger.debug('Gather:exec task has completed');
    } catch (err) {
      this.logger.error(err, 'TaskGather:exec error');
    }
    ep.removeCustomEventListener(GoogleTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(GoogleTranscriptionEvents.EndOfUtterance);
    ep.removeCustomEventListener(AwsTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(AzureTranscriptionEvents.Transcription);
    ep.removeCustomEventListener(AzureTranscriptionEvents.NoSpeechDetected);
  }

  kill(cs) {
    this.logger.debug('Gather:kill');
    super.kill(cs);
    this._killAudio(cs);
    this.ep.removeAllListeners('dtmf');
    this._resolve('killed');
  }

  _onDtmf(cs, ep, evt) {
    this.logger.debug(evt, 'TaskGather:_onDtmf');
    clearTimeout(this.interDigitTimer);
    let resolved = false;
    if (this.dtmfBargein) this._killAudio(cs);
    if (evt.dtmf === this.finishOnKey) {
      resolved = true;
      this._resolve('dtmf-terminator-key');
    }
    else {
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

  async _initSpeech(cs, ep) {
    const opts = {};

    if ('google' === this.vendor) {
      if (this.sttCredentials) opts.GOOGLE_APPLICATION_CREDENTIALS = JSON.stringify(this.sttCredentials.credentials);
      Object.assign(opts, {
        GOOGLE_SPEECH_USE_ENHANCED: true,
        GOOGLE_SPEECH_SINGLE_UTTERANCE: true,
        GOOGLE_SPEECH_MODEL: 'command_and_search'
      });
      if (this.hints && this.hints.length > 1) {
        opts.GOOGLE_SPEECH_HINTS = this.hints.map((h) => h.trim()).join(',');
      }
      if (this.altLanguages && this.altLanguages.length > 1) {
        opts.GOOGLE_SPEECH_ALTERNATIVE_LANGUAGE_CODES = this.altLanguages.join(',');
      }
      if (this.profanityFilter === true) {
        Object.assign(opts, {'GOOGLE_SPEECH_PROFANITY_FILTER': true});
      }
      ep.addCustomEventListener(GoogleTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
      ep.addCustomEventListener(GoogleTranscriptionEvents.EndOfUtterance, this._onEndOfUtterance.bind(this, cs, ep));
    }
    else if (['aws', 'polly'].includes(this.vendor)) {
      if (this.vocabularyName) opts.AWS_VOCABULARY_NAME = this.vocabularyName;
      if (this.vocabularyFilterName) {
        opts.AWS_VOCABULARY_NAME = this.vocabularyFilterName;
        opts.AWS_VOCABULARY_FILTER_METHOD = this.filterMethod || 'mask';
      }
      if (this.sttCredentials) {
        Object.assign(opts, {
          AWS_ACCESS_KEY_ID: this.sttCredentials.accessKeyId,
          AWS_SECRET_ACCESS_KEY: this.sttCredentials.secretAccessKey,
          AWS_REGION: this.sttCredentials.region
        });
      }
      ep.addCustomEventListener(AwsTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
    }
    else if ('microsoft' === this.vendor) {
      if (this.sttCredentials) {
        Object.assign(opts, {
          'AZURE_SUBSCRIPTION_KEY': this.sttCredentials.api_key,
          'AZURE_REGION': this.sttCredentials.region
        });
      }
      if (this.hints && this.hints.length > 1) {
        opts.AZURE_SPEECH_HINTS = this.hints.map((h) => h.trim()).join(',');
      }
      //if (this.requestSnr) opts.AZURE_REQUEST_SNR = 1;
      //if (this.profanityOption !== 'raw') opts.AZURE_PROFANITY_OPTION = this.profanityOption;
      if (this.initialSpeechTimeoutMs > 0) opts.AZURE_INITIAL_SPEECH_TIMEOUT_MS = this.initialSpeechTimeoutMs;
      opts.AZURE_USE_OUTPUT_FORMAT_DETAILED = 1;

      ep.addCustomEventListener(AzureTranscriptionEvents.Transcription, this._onTranscription.bind(this, cs, ep));
      ep.addCustomEventListener(AzureTranscriptionEvents.NoSpeechDetected, this._onNoSpeechDetected.bind(this, cs, ep));
    }
    await ep.set(opts)
      .catch((err) => this.logger.info(err, 'Error setting channel variables'));
  }

  _startTranscribing(ep) {
    ep.startTranscription({
      vendor: this.vendor,
      locale: this.language,
      interim: this.interim,
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
    assert(!this._timeoutTimer);
    this.logger.debug(`Gather:_startTimer: timeout ${this.timeout}`);
    this._timeoutTimer = setTimeout(() => this._resolve('timeout'), this.timeout);
  }

  _clearTimer() {
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  }

  _killAudio(cs) {
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

  _onTranscription(cs, ep, evt) {
    this.logger.debug(evt, 'TaskGather:_onTranscription');
    if ('aws' === this.vendor && Array.isArray(evt) && evt.length > 0) evt = evt[0];
    if ('microsoft' === this.vendor) {
      const final = evt.RecognitionStatus === 'Success';
      if (final) {
        const nbest = evt.NBest;
        evt = {
          is_final: true,
          alternatives: [
            {
              confidence: nbest[0].Confidence,
              transcript: nbest[0].Display
            }
          ]
        };
      }
      else {
        evt = {
          is_final: false,
          alternatives: [
            {
              transcript: evt.Text
            }
          ]
        };
      }
    }
    if (evt.is_final) this._resolve('speech', evt);
    else {
      const recognizeSuccess = evt.stability > GATHER_STABILITY_THRESHOLD;
      /* 
        we need to make sure to only send something on barge in if we have 
        something valid therefore we need to check the recognition
        stability, which applies to GOOGLE
        for MS we will have a final event, meaning we will not run into 
        the current if else branch.

        For AWS we still need more testing
      */
      if (recognizeSuccess &&
        this.bargein &&
        evt.alternatives[0].transcript.split(' ').length >= this.minBargeinWordCount) {
        this.logger.debug('Gather:_onTranscription - killing audio due to bargein');
        this._killAudio(cs);
        this._resolve('speech', evt);
      }
      if (this.partialResultHook) {
        this.cs.requestor.request(this.partialResultHook,  Object.assign({speech: evt}, this.cs.callInfo))
          .catch((err) => this.logger.info(err, 'GatherTask:_onTranscription error'));
      }
    }
  }
  _onEndOfUtterance(cs, ep) {
    this.logger.info('TaskGather:_onEndOfUtterance');
    if (!this.resolved && !this.killed) {
      this._startTranscribing(ep);
    }
  }

  _onNoSpeechDetected(cs, ep) {
    this._resolve('timeout');
  }

  async _resolve(reason, evt) {
    if (this.resolved) return;
    this.resolved = true;
    this.logger.debug(`TaskGather:resolve with reason ${reason}`);

    if (this.ep && this.ep.connected) {
      this.ep.stopTranscription({vendor: this.vendor})
        .catch((err) => this.logger.error({err}, 'Error stopping transcription'));
    }

    this._clearTimer();
    if (reason.startsWith('dtmf')) {
      if (this.parentTask) this.parentTask.emit('dtmf-collected', {reason, digits: this.digitBuffer});
      else await this.performAction({digits: this.digitBuffer, reason: 'dtmfDetected'});
    }
    else if (reason.startsWith('speech')) {
      if (this.parentTask) this.parentTask.emit('transcription', evt);
      else await this.performAction({speech: evt, reason: 'speechDetected'});
    }
    else if (reason.startsWith('timeout')) {
      if (this.parentTask) this.parentTask.emit('timeout', evt);
      else await this.performAction({reason: 'timeout'});
    }
    this.notifyTaskDone();
  }
}

module.exports = TaskGather;
