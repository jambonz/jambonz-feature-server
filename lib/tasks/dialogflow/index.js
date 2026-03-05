const assert = require('assert');
const Task = require('../task');
const {TaskName, TaskPreconditions} = require('../../utils/constants');
const Intent = require('./intent');
const DigitBuffer = require('./digit-buffer');
const Transcription = require('./transcription');
const { normalizeJambones } = require('@jambonz/verb-specifications');

class Dialogflow extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;
    this.credentials = this.data.credentials;
    this.project = this.data.project;
    this.agent = this.data.agent;
    this.region = this.data.region || 'us-central1';
    this.model = this.data.model || 'es';

    assert(this.agent || !this.isCX, 'agent is required for dialogflow cx');
    assert(this.credentials, 'dialogflow credentials are required');

    if (this.isCX) {
      this.environment = this.data.environment || 'none';
    }
    else {
      if (this.data.environment && this.data.region) {
        this.project = `${this.data.project}:${this.data.environment}:${this.data.region}`;
      }
      else if (this.data.environment) {
        this.project = `${this.data.project}:${this.data.environment}`;
      }
      else if (this.data.region) {
        this.project = `${this.data.project}::${this.data.region}`;
      }
    }

    this.lang = this.data.lang || 'en-US';
    this.welcomeEvent = this.data.welcomeEvent || '';
    if (this.welcomeEvent.length && this.data.welcomeEventParams && typeof this.data.welcomeEventParams === 'object') {
      this.welcomeEventParams = this.data.welcomeEventParams;
    }
    if (this.data.noInputTimeout) this.noInputTimeout = this.data.noInputTimeout * 1000;
    else this.noInputTimeout = 20000;
    this.noInputEvent = this.data.noInputEvent || 'actions_intent_NO_INPUT';
    this.passDtmfAsInputText = this.passDtmfAsInputText === true;
    if (this.data.eventHook) this.eventHook = this.data.eventHook;
    if (this.eventHook && Array.isArray(this.data.events)) {
      this.events = this.data.events;
    }
    else if (this.eventHook) {
      this.events = [
        'intent',
        'transcription',
        'dtmf',
        'start-play',
        'stop-play',
        'no-input'
      ];
    }
    else {
      this.events = [];
    }
    if (this.data.actionHook) this.actionHook = this.data.actionHook;
    if (this.data.thinkingMusic) this.thinkingMusic = this.data.thinkingMusic;
    if (this.data.tts) {
      this.vendor = this.data.tts.vendor || 'default';
      this.language = this.data.tts.language || 'default';
      this.voice = this.data.tts.voice || 'default';
      this.speechSynthesisLabel = this.data.tts.label;

      this.fallbackVendor = this.data.tts.fallbackVendor || 'default';
      this.fallbackLanguage = this.data.tts.fallbackLanguage || 'default';
      this.fallbackVoice = this.data.tts.fallbackVoice || 'default';
      this.fallbackLabel = this.data.tts.fallbackLabel;
    }
    this.bargein = this.data.bargein;

    this.cmd = this.isCX ? 'dialogflow_cx_start' : 'dialogflow_start';
    this.cmdStop = this.isCX ? 'dialogflow_cx_stop' : 'dialogflow_stop';

    // CX-specific state
    this._suppressNextCXAudio = false;
    this._cxAudioHandled = false;
  }

  get name() { return TaskName.Dialogflow; }

  get isCX() { return this.model === 'cx'; }

  get isES() { return !this.isCX; }

  async exec(cs, {ep}) {
    await super.exec(cs);

    try {
      await this.init(cs, ep);
      await this.startBot('default');
      await this.awaitTaskDone();
    } catch (err) {
      this.logger.error({err}, 'Dialogflow:exec error');
    }
  }

  async kill(cs) {
    super.kill(cs);
    if (this.ep.connected) {
      this.logger.debug('TaskDialogFlow:kill');
      this.ep.removeCustomEventListener('dialogflow::intent');
      this.ep.removeCustomEventListener('dialogflow::transcription');
      this.ep.removeCustomEventListener('dialogflow::audio_provided');
      this.ep.removeCustomEventListener('dialogflow::end_of_utterance');
      this.ep.removeCustomEventListener('dialogflow::error');

      this.ep.removeCustomEventListener('dialogflow_cx::intent');
      this.ep.removeCustomEventListener('dialogflow_cx::transcription');
      this.ep.removeCustomEventListener('dialogflow_cx::audio_provided');
      this.ep.removeCustomEventListener('dialogflow_cx::end_of_utterance');
      this.ep.removeCustomEventListener('dialogflow_cx::error');

      this._clearNoinputTimer();

      if (!this.reportedFinalAction) this.performAction({dialogflowResult: 'caller hungup'})
        .catch((err) => this.logger.error({err}, 'dialogflow - error w/ action webook'));

      await this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
    }
    this.notifyTaskDone();
  }

  async init(cs, ep) {
    this.ep = ep;
    try {
      if (this.vendor === 'default') {
        this.vendor = cs.speechSynthesisVendor;
        this.language = cs.speechSynthesisLanguage;
        this.voice = cs.speechSynthesisVoice;
        this.speechSynthesisLabel = cs.speechSynthesisLabel;
      }
      if (this.fallbackVendor === 'default') {
        this.fallbackVendor = cs.fallbackSpeechSynthesisVendor;
        this.fallbackLanguage = cs.fallbackSpeechSynthesisLanguage;
        this.fallbackVoice = cs.fallbackSpeechSynthesisVoice;
        this.fallbackLabel = cs.fallbackSpeechSynthesisLabel;
      }
      this.ttsCredentials = cs.getSpeechCredentials(this.vendor, 'tts', this.speechSynthesisLabel);

      this.ep.addCustomEventListener('dialogflow::intent', this._onIntent.bind(this, ep, cs));
      this.ep.addCustomEventListener('dialogflow::transcription', this._onTranscription.bind(this, ep, cs));
      this.ep.addCustomEventListener('dialogflow::audio_provided', this._onAudioProvided.bind(this, ep, cs));
      this.ep.addCustomEventListener('dialogflow::end_of_utterance', this._onEndOfUtterance.bind(this, ep, cs));
      this.ep.addCustomEventListener('dialogflow::error', this._onError.bind(this, ep, cs));

      this.ep.addCustomEventListener('dialogflow_cx::intent', this._onIntent.bind(this, ep, cs));
      this.ep.addCustomEventListener('dialogflow_cx::transcription', this._onTranscription.bind(this, ep, cs));
      this.ep.addCustomEventListener('dialogflow_cx::audio_provided', this._onAudioProvided.bind(this, ep, cs));
      this.ep.addCustomEventListener('dialogflow_cx::end_of_utterance', this._onEndOfUtterance.bind(this, ep, cs));
      this.ep.addCustomEventListener('dialogflow_cx::error', this._onError.bind(this, ep, cs));

      const obj = typeof this.credentials === 'string' ? JSON.parse(this.credentials) : this.credentials;
      const creds = JSON.stringify(obj);
      await this.ep.set('GOOGLE_APPLICATION_CREDENTIALS', creds);

    } catch (err) {
      this.logger.error({err}, 'Error setting credentials');
      throw err;
    }
  }

  async startBot(intent) {
    if (this.isCX) {
      const event = this.welcomeEvent || intent;
      const args = this._buildStartArgs({
        event: event && event !== 'default' ? event : undefined
      });
      this.logger.info({args}, 'starting dialogflow CX bot');
      await this.ep.api(this.cmd, args);
    }
    else {
      await this._startBotES();
    }
  }

  async _startBotES() {
    this.logger.info('starting dialogflow ES bot');
    const baseArgs = `${this.ep.uuid} ${this.project} ${this.lang} ${this.welcomeEvent}`;
    if (this.welcomeEventParams) {
      await this.ep.api(this.cmd, `${baseArgs} '${JSON.stringify(this.welcomeEventParams)}'`);
    }
    else if (this.welcomeEvent.length) {
      await this.ep.api(this.cmd, baseArgs);
    }
    else {
      await this.ep.api(this.cmd, `${this.ep.uuid} ${this.project} ${this.lang}`);
    }
  }

  /**
   * Build the start command args string for either ES or CX.
   * @param {object} opts - options
   * @param {string} opts.event - optional event to send
   * @param {string} opts.text - optional text to send
   * @param {number} opts.singleUtterance - 1 or 0 (CX only, default 1)
   * @returns {string} command args string
   */
  _buildStartArgs({event, text, singleUtterance = 1} = {}) {
    if (this.isCX) {
      const args = [
        this.ep.uuid,
        this.project,
        this.region,
        this.agent,
        this.environment || 'none',
        this.lang,
        event || 'none',
        text ? `'${text}'` : 'none',
        singleUtterance ? '1' : '0',
      ];
      return args.join(' ');
    }
    // ES
    const args = [this.ep.uuid, this.project, this.lang];
    if (event) {
      args.push(event);
    }
    if (text) {
      if (!event) args.push('none');
      args.push(`'${text}'`);
    }
    return args.join(' ');
  }

  /**
   * An intent has been returned.  Since we are using SINGLE_UTTERANCE on the dialogflow side,
   * we may get an empty intent, signified by the lack of a 'response_id' attribute.
   * In such a case, we just start another StreamingIntentDetectionRequest.
   * @param {*} ep -  media server endpoint
   * @param {*} cs - call session
   * @param {*} evt - event data
   */
  async _onIntent(ep, cs, evt) {
    const intent = new Intent(this.logger, evt);

    if (intent.isEmpty) {
      if (this.noinput && this.greetingPlayed) {
        this.logger.info('no input timer fired, reprompting..');
        this.noinput = false;
        ep.api(this.cmd, this._buildStartArgs({event: this.noInputEvent}));
      }
      else if (this.dtmfEntry && this.greetingPlayed) {
        this.logger.info('dtmf detected, reprompting..');
        ep.api(this.cmd, this._buildStartArgs({text: this.dtmfEntry}));
        this.dtmfEntry = null;
      }
      else {
        this.logger.info('got empty intent, restarting');
        ep.api(this.cmd, this._buildStartArgs());
      }
      return;
    }

    // For CX: suppress NO_INPUT "I didn't get that" audio and silently restart
    if (this.isCX && intent.isNoInput && this.greetingPlayed) {
      this.logger.info('CX returned NO_INPUT after greeting, suppressing and restarting');
      this._suppressNextCXAudio = true;
      return;
    }

    if (this.events.includes('intent')) {
      this._performHook(cs, this.eventHook, {event: 'intent', data: evt});
    }

    this._clearNoinputTimer();
    if (this.digitBuffer) this.digitBuffer.flush();

    if (intent.saysEndInteraction) {
      this.hangupAfterPlayDone = true;
      this.waitingForPlayStart = true;
      setTimeout(() => {
        if (this.waitingForPlayStart) {
          this.logger.info('hanging up since intent was marked end interaction');
          this.performAction({dialogflowResult: 'completed'});
          this.notifyTaskDone();
        }
      }, 1000);
    }
    else if (intent.saysCollectDtmf || this.enableDtmfAlways) {
      const opts = Object.assign({
        idt: this.opts.interDigitTimeout
      }, intent.dtmfInstructions || {term: '#'});
      this.digitBuffer = new DigitBuffer(this.logger, opts);
      this.digitBuffer.once('fulfilled', this._onDtmfEntryComplete.bind(this, ep));
    }

    // If we have a TTS vendor and fulfillment text, synthesize and play
    if (this.vendor && intent.fulfillmentText && intent.fulfillmentText.length > 0) {
      this.waitingForPlayStart = false;

      // ES: start a new intent during playback so we continue to listen
      if (!this.hangupAfterPlayDone && this.isES) {
        ep.api(this.cmd, this._buildStartArgs());
      }

      try {
        const {srf} = cs;
        const {stats} = srf.locals;
        const {synthAudio} = srf.locals.dbHelpers;
        const {filePath} = await this._fallbackSynthAudio(cs, intent, stats, synthAudio);
        if (filePath) cs.trackTmpFile(filePath);
        await this._playAndHandlePostPlay(ep, cs, filePath);
      } catch (err) {
        this.logger.error({err}, 'Dialogflow:_onIntent - error playing tts');
      }
    }
    else if (this.isCX && !this.hangupAfterPlayDone) {
      // CX intent with no TTS — _onAudioProvided may handle playback.
      // If not, restart CX after a short delay.
      this.greetingPlayed = true;
      this._cxAudioHandled = false;
      setTimeout(() => {
        if (!this._cxAudioHandled && !this.playInProgress) {
          this.logger.info('CX: no TTS and no audio provided, restarting to listen');
          ep.api(this.cmd, this._buildStartArgs());
          this._startNoinputTimer(ep, cs);
        }
      }, 500);
    }
  }

  async _fallbackSynthAudio(cs, intent, stats, synthAudio) {
    try {
      return await synthAudio(stats, {
        account_sid: cs.accountSid,
        text: intent.fulfillmentText,
        vendor: this.vendor,
        language: this.language,
        voice: this.voice,
        salt: cs.callSid,
        credentials: this.ttsCredentials
      });
    } catch (error) {
      this.logger.info({error}, 'Failed to synthesize audio from primary vendor');
      if (this.fallbackVendor) {
        try {
          const credentials = cs.getSpeechCredentials(this.fallbackVendor, 'tts', this.fallbackLabel);
          return await synthAudio(stats, {
            account_sid: cs.accountSid,
            text: intent.fulfillmentText,
            vendor: this.fallbackVendor,
            language: this.fallbackLanguage,
            voice: this.fallbackVoice,
            salt: cs.callSid,
            credentials
          });
        } catch (err) {
          this.logger.info({err}, 'Failed to synthesize audio from fallback vendor');
          throw err;
        }
      }
      throw error;
    }
  }

  /**
   * A transcription has been returned.
   * @param {*} ep -  media server endpoint
   * @param {*} cs - call session
   * @param {*} evt - event data
   */
  async _onTranscription(ep, cs, evt) {
    const transcription = new Transcription(this.logger, evt);

    if (this.events.includes('transcription') && transcription.isFinal) {
      this._performHook(cs, this.eventHook, {event: 'transcription', data: evt});
    }
    else if (this.events.includes('interim-transcription') && !transcription.isFinal) {
      this._performHook(cs, this.eventHook, {event: 'transcription', data: evt});
    }

    if (this.thinkingMusic && !transcription.isEmpty && transcription.isFinal &&
      transcription.confidence > 0.8) {
      ep.play(this.data.thinkingMusic).catch((err) => this.logger.info(err, 'Error playing typing sound'));
    }

    if (this.bargein && this.playInProgress) {
      this.logger.debug('terminating playback due to speech bargein');
      this.playInProgress = false;
      await ep.api('uuid_break', ep.uuid);
    }
  }

  /**
   * The caller has just finished speaking.
   * @param {*} ep -  media server endpoint
   * @param {*} cs - call session
   * @param {*} evt - event data
   */
  _onEndOfUtterance(ep, cs, evt) {
    if (this.events.includes('end-utterance')) {
      this._performHook(cs, this.eventHook, {event: 'end-utterance'});
    }
  }

  /**
   * Dialogflow has returned an error.
   * @param {*} ep -  media server endpoint
   * @param {*} cs - call session
   * @param {*} evt - event data
   */
  _onError(ep, cs, evt) {
    this.logger.error(`got error: ${JSON.stringify(evt)}`);
  }

  /**
   * Audio has been received from dialogflow and written to a temporary disk file.
   * Play the audio, then restart or hang up as appropriate.
   * @param {*} ep -  media server endpoint
   * @param {*} cs - call session
   * @param {*} evt - event data
   */
  async _onAudioProvided(ep, cs, evt) {
    // For CX: suppress NO_INPUT reprompt audio and silently restart
    if (this._suppressNextCXAudio) {
      this._suppressNextCXAudio = false;
      ep.api(this.cmd, this._buildStartArgs());
      return;
    }

    if (this.vendor) {
      if (this.isCX && !this.playInProgress) {
        // CX audio arrived but TTS didn't play — fall through to use CX audio
        this.logger.info('CX audio provided, TTS vendor did not play - using CX audio');
      } else {
        return;
      }
    }

    this._cxAudioHandled = true;
    this.waitingForPlayStart = false;

    await ep.api('uuid_break', ep.uuid);

    // ES: start a new intent during playback so we continue to listen
    if (!this.hangupAfterPlayDone && this.isES) {
      ep.api(this.cmd, this._buildStartArgs());
    }

    await this._playAndHandlePostPlay(ep, cs, evt.path);
  }

  /**
   * Shared post-play logic for both TTS (_onIntent) and CX audio (_onAudioProvided).
   * Plays audio, then either hangs up, redirects, or restarts the dialog.
   */
  async _playAndHandlePostPlay(ep, cs, filePath) {
    if (this.playInProgress) {
      await ep.api('uuid_break', ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
    }
    this.playInProgress = true;
    this.curentAudioFile = filePath;

    if (this.events.includes('start-play')) {
      this._performHook(cs, this.eventHook, {event: 'start-play', data: {path: filePath}});
    }
    await ep.play(filePath);
    if (this.events.includes('stop-play')) {
      this._performHook(cs, this.eventHook, {event: 'stop-play', data: {path: filePath}});
    }

    if (this.curentAudioFile === filePath) {
      this.playInProgress = false;
      if (this.queuedTasks) {
        this._redirect(cs, this.queuedTasks);
        this.queuedTasks = null;
        return;
      }
    }

    this.greetingPlayed = true;

    if (this.hangupAfterPlayDone) {
      this.logger.info('hanging up after end interaction prompt');
      this.performAction({dialogflowResult: 'completed'});
      this.notifyTaskDone();
    }
    else {
      // CX: restart to listen for the next utterance
      if (this.isCX) {
        ep.api(this.cmd, this._buildStartArgs());
      }
      this._startNoinputTimer(ep, cs);
    }
  }

  /**
   * Receive a DTMF entry from the caller.
   */
  _onDtmf(ep, cs, evt) {
    if (this.digitBuffer) this.digitBuffer.process(evt.dtmf);
    if (this.events.includes('dtmf')) {
      this._performHook(cs, this.eventHook, {event: 'dtmf', data: evt});
    }
  }

  async _onDtmfEntryComplete(ep, dtmfEntry) {
    this.logger.info(`collected dtmf entry: ${dtmfEntry}`);
    this.digitBuffer = null;
    if (this.thinkingMusic) {
      ep.play(this.thinkingMusic).catch((err) => this.logger.info(err, 'Error playing typing sound'));
    }

    if (this.isCX) {
      try {
        await ep.api(this.cmdStop, ep.uuid);
      } catch (err) {
        this.logger.info(err, 'dialogflow_cx_stop failed');
      }
      ep.api(this.cmd, this._buildStartArgs({text: dtmfEntry}));
    } else {
      this.dtmfEntry = dtmfEntry;
      ep.api(this.cmdStop, `${ep.uuid}`)
        .catch((err) => this.logger.info(`dialogflow_stop failed: ${err.message}`));
    }
  }

  async _onNoInput(ep, cs) {
    this.logger.info('no-input timer fired');

    if (this.events.includes('no-input')) {
      this._performHook(cs, this.eventHook, {event: 'no-input'});
    }

    if (this.isCX) {
      try {
        await ep.api(this.cmdStop, ep.uuid);
      } catch (err) {
        this.logger.info(err, 'dialogflow_cx_stop failed');
      }
      ep.api(this.cmd, this._buildStartArgs({event: this.noInputEvent}));
    } else {
      this.noinput = true;
      ep.api(this.cmdStop, `${ep.uuid}`)
        .catch((err) => this.logger.info(`dialogflow_stop failed: ${err.message}`));
    }
  }

  _clearNoinputTimer() {
    if (this.noinputTimer) {
      clearTimeout(this.noinputTimer);
      this.noinputTimer = null;
    }
  }

  _startNoinputTimer(ep, cs) {
    if (!this.noInputTimeout) return;
    this._clearNoinputTimer();
    this.noinputTimer = setTimeout(this._onNoInput.bind(this, ep, cs), this.noInputTimeout);
  }

  async _performHook(cs, hook, results = {}) {
    const b3 = this.getTracingPropagation();
    const httpHeaders = b3 && {b3};
    const json = await this.cs.requestor.request('verb:hook', hook,
      {...results, ...cs.callInfo.toJSON()}, httpHeaders);
    if (json && Array.isArray(json)) {
      const makeTask = require('../make_task');
      const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
      if (tasks && tasks.length > 0) {
        if (this.playInProgress) {
          this.queuedTasks = tasks;
          this.logger.info({tasks},
            `${this.name} replacing application with ${tasks.length} tasks after play completes`);
          return;
        }
        this._redirect(cs, tasks);
      }
    }
  }

  _redirect(cs, tasks) {
    this.logger.info({tasks}, `${this.name} replacing application with ${tasks.length} tasks`);
    this.performAction({dialogflowResult: 'redirect'}, false);
    this.reportedFinalAction = true;
    cs.replaceApplication(tasks);
  }

}

module.exports = Dialogflow;
