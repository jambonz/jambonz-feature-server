const Task = require('../task');
const {TaskName, TaskPreconditions} = require('../../utils/constants');
const Intent = require('./intent');
const DigitBuffer = require('./digit-buffer');
const Transcription = require('./transcription');
const normalizeJambones = require('../../utils/normalize-jambones');

class Dialogflow extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;
    this.credentials = this.data.credentials;

    /* set project id with environment and region (optionally) */
    if (this.data.environment && this.data.region) {
      this.project = `${this.data.project}:${this.data.environment}:${this.data.region}`;
    }
    else if (this.data.environment) {
      this.project = `${this.data.project}:${this.data.environment}`;
    }
    else if (this.data.region) {
      this.project = `${this.data.project}::${this.data.region}`;
    }
    else {
      this.project = this.data.project;
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
      // send all events by default - except interim transcripts
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
    }
    this.bargein = this.data.bargein;
  }

  get name() { return TaskName.Dialogflow; }

  async exec(cs, {ep}) {
    await super.exec(cs);

    try {
      await this.init(cs, ep);

      this.logger.debug(`starting dialogflow bot ${this.project}`);

      // kick it off
      const baseArgs = `${this.ep.uuid} ${this.project} ${this.lang} ${this.welcomeEvent}`;
      if (this.welcomeEventParams) {
        this.ep.api('dialogflow_start', `${baseArgs} '${JSON.stringify(this.welcomeEventParams)}'`);
      }
      else if (this.welcomeEvent.length) {
        this.ep.api('dialogflow_start', baseArgs);
      }
      else {
        this.ep.api('dialogflow_start', `${this.ep.uuid} ${this.project} ${this.lang}`);
      }
      this.logger.debug(`started dialogflow bot ${this.project}`);

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
      }
      this.ttsCredentials = cs.getSpeechCredentials(this.vendor, 'tts');

      this.ep.addCustomEventListener('dialogflow::intent', this._onIntent.bind(this, ep, cs));
      this.ep.addCustomEventListener('dialogflow::transcription', this._onTranscription.bind(this, ep, cs));
      this.ep.addCustomEventListener('dialogflow::audio_provided', this._onAudioProvided.bind(this, ep, cs));
      this.ep.addCustomEventListener('dialogflow::end_of_utterance', this._onEndOfUtterance.bind(this, ep, cs));
      this.ep.addCustomEventListener('dialogflow::error', this._onError.bind(this, ep, cs));

      const obj = typeof this.credentials === 'string' ? JSON.parse(this.credentials) : this.credentials;
      const creds = JSON.stringify(obj);
      await this.ep.set('GOOGLE_APPLICATION_CREDENTIALS', creds);

    } catch (err) {
      this.logger.error({err}, 'Error setting credentials');
      throw err;
    }
  }

  /**
   * An intent has been returned.  Since we are using SINGLE_UTTERANCE on the dialogflow side,
   * we may get an empty intent, signified by the lack of a 'response_id' attribute.
   * In such a case, we just start another StreamingIntentDetectionRequest.
   * @param {*} ep -  media server endpoint
   * @param {*} evt - event data
   */
  async _onIntent(ep, cs, evt) {
    const intent = new Intent(this.logger, evt);

    if (intent.isEmpty) {
      /**
       * An empty intent is returned in 3 conditions:
       * 1. Our no-input timer fired
       * 2. We collected dtmf that needs to be fed to dialogflow
       * 3. A normal dialogflow timeout
       */
      if (this.noinput && this.greetingPlayed) {
        this.logger.info('no input timer fired, reprompting..');
        this.noinput = false;
        ep.api('dialogflow_start', `${ep.uuid} ${this.project} ${this.lang} ${this.noInputEvent}`);
      }
      else if (this.dtmfEntry && this.greetingPlayed) {
        this.logger.info('dtmf detected, reprompting..');
        ep.api('dialogflow_start', `${ep.uuid} ${this.project} ${this.lang} none \'${this.dtmfEntry}\'`);
        this.dtmfEntry = null;
      }
      else if (this.greetingPlayed) {
        this.logger.info('starting another intent');
        ep.api('dialogflow_start', `${ep.uuid} ${this.project} ${this.lang}`);
      }
      else {
        this.logger.info('got empty intent');
        ep.api('dialogflow_start', `${ep.uuid} ${this.project} ${this.lang}`);
      }
      return;
    }

    if (this.events.includes('intent')) {
      this._performHook(cs, this.eventHook, {event: 'intent', data: evt});
    }

    // clear the no-input timer and the digit buffer
    this._clearNoinputTimer();
    if (this.digitBuffer) this.digitBuffer.flush();

    /* hang up (or tranfer call) after playing next audio file? */
    if (intent.saysEndInteraction) {
      //  if 'end_interaction' is true, end the dialog after playing the final prompt
      //  (or in 1 second if there is no final prompt)
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

    /* collect digits? */
    else if (intent.saysCollectDtmf || this.enableDtmfAlways) {
      const opts = Object.assign({
        idt: this.opts.interDigitTimeout
      }, intent.dtmfInstructions || {term: '#'});
      this.digitBuffer = new DigitBuffer(this.logger, opts);
      this.digitBuffer.once('fulfilled', this._onDtmfEntryComplete.bind(this, ep));
    }

    /* if we are using tts and a message was provided, play it out */
    if (this.vendor && intent.fulfillmentText && intent.fulfillmentText.length > 0) {
      const {srf} = cs;
      const {stats} = srf.locals;
      const {synthAudio} = srf.locals.dbHelpers;
      this.waitingForPlayStart = false;

      // start a new intent, (we want to continue to listen during the audio playback)
      // _unless_ we are transferring or ending the session
      if (!this.hangupAfterPlayDone) {
        ep.api('dialogflow_start', `${ep.uuid} ${this.project} ${this.lang}`);
      }

      try {
        const obj = {
          text: intent.fulfillmentText,
          vendor: this.vendor,
          language: this.language,
          voice: this.voice,
          salt: cs.callSid,
          credentials: this.ttsCredentials
        };
        this.logger.debug({obj}, 'Dialogflow:_onIntent - playing message via tts');
        const {filePath, servedFromCache} = await synthAudio(stats, obj);
        if (filePath) cs.trackTmpFile(filePath);
        if (!this.ttsCredentials && !servedFromCache) cs.billForTts(intent.fulfillmentText.length);

        if (this.playInProgress) {
          await ep.api('uuid_break', ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
        }
        this.playInProgress = true;
        this.curentAudioFile = filePath;

        this.logger.debug(`starting to play tts ${filePath}`);

        if (this.events.includes('start-play')) {
          this._performHook(cs, this.eventHook, {event: 'start-play', data: {path: filePath}});
        }
        await ep.play(filePath);
        if (this.events.includes('stop-play')) {
          this._performHook(cs, this.eventHook, {event: 'stop-play', data: {path: filePath}});
        }
        this.logger.debug(`finished ${filePath}`);

        if (this.curentAudioFile === filePath) {
          this.playInProgress = false;
          if (this.queuedTasks) {
            this.logger.debug('finished playing audio and we have queued tasks');
            this._redirect(cs, this.queuedTasks);
            return;
          }
        }
        this.greetingPlayed = true;

        if (this.hangupAfterPlayDone) {
          this.logger.info('hanging up since intent was marked end interaction and we completed final prompt');
          this.performAction({dialogflowResult: 'completed'});
          this.notifyTaskDone();
        }
        else {
          // every time we finish playing a prompt, start the no-input timer
          this._startNoinputTimer(ep, cs);
        }
      } catch (err) {
        this.logger.error({err}, 'Dialogflow:_onIntent - error playing tts');
      }
    }
  }

  /**
   * A transcription - either interim or final - has been returned.
   * If we are doing barge-in based on hotword detection, check for the hotword or phrase.
   * If we are playing a filler sound, like typing, during the fullfillment phase, start that
   * if this is a final transcript.
   * @param {*} ep  -  media server endpoint
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

    // if a final transcription, start a typing sound
    if (this.thinkingMusic && !transcription.isEmpty && transcription.isFinal &&
      transcription.confidence > 0.8) {
      ep.play(this.data.thinkingMusic).catch((err) => this.logger.info(err, 'Error playing typing sound'));
    }

    // interrupt playback on speaking if bargein = true
    if (this.bargein && this.playInProgress) {
      this.logger.debug('terminating playback due to speech bargein');
      this.playInProgress = false;
      await ep.api('uuid_break', ep.uuid);
    }
  }

  /**
   * The caller has just finished speaking.  No action currently taken.
   * @param {*} evt - event data
   */
  _onEndOfUtterance(cs, evt) {
    if (this.events.includes('end-utterance')) {
      this._performHook(cs, this.eventHook, {event: 'end-utterance'});
    }
  }

  /**
   * Dialogflow has returned an error of some kind.
   * @param {*} evt - event data
   */
  _onError(ep, cs, evt) {
    this.logger.error(`got error: ${JSON.stringify(evt)}`);
  }

  /**
   * Audio has been received from dialogflow and written to a temporary disk file.
   * Start playing the audio, after killing any filler sound that might be playing.
   * When the audio completes, start the no-input timer.
   * @param {*} ep -  media server endpoint
   * @param {*} evt - event data
   */
  async _onAudioProvided(ep, cs, evt) {

    if (this.vendor) return;

    this.waitingForPlayStart = false;

    // kill filler audio
    await ep.api('uuid_break', ep.uuid);

    // start a new intent, (we want to continue to listen during the audio playback)
    // _unless_ we are transferring or ending the session
    if (/*this.greetingPlayed &&*/ !this.hangupAfterPlayDone) {
      ep.api('dialogflow_start', `${ep.uuid} ${this.project} ${this.lang}`);
    }

    this.playInProgress = true;
    this.curentAudioFile = evt.path;

    this.logger.info(`starting to play ${evt.path}`);
    if (this.events.includes('start-play')) {
      this._performHook(cs, this.eventHook, {event: 'start-play', data: {path: evt.path}});
    }
    await ep.play(evt.path);
    if (this.events.includes('stop-play')) {
      this._performHook(cs, this.eventHook, {event: 'stop-play', data: {path: evt.path}});
    }
    this.logger.info(`finished ${evt.path}, queued tasks: ${(this.queuedTasks || []).length}`);

    if (this.curentAudioFile === evt.path) {
      this.playInProgress = false;
      if (this.queuedTasks) {
        this.logger.debug('finished playing audio and we have queued tasks');
        this._redirect(cs, this.queuedTasks);
        this.queuedTasks.length = 0;
        return;
      }
    }
    /*
    if (!this.inbound && !this.greetingPlayed) {
      this.logger.info('finished greeting on outbound call, starting new intent');
      this.ep.api('dialogflow_start', `${ep.uuid} ${this.project} ${this.lang}`);
    }
    */
    this.greetingPlayed = true;

    if (this.hangupAfterPlayDone) {
      this.logger.info('hanging up since intent was marked end interaction and we completed final prompt');
      this.performAction({dialogflowResult: 'completed'});
      this.notifyTaskDone();
    }
    else {
      // every time we finish playing a prompt, start the no-input timer
      this._startNoinputTimer(ep, cs);
    }
  }

  /**
   * receive a dmtf entry from the caller.
   * If we have active dtmf instructions, collect and process accordingly.
   */
  _onDtmf(ep, cs, evt) {
    if (this.digitBuffer) this.digitBuffer.process(evt.dtmf);
    if (this.events.includes('dtmf')) {
      this._performHook(cs, this.eventHook, {event: 'dtmf', data: evt});
    }
  }

  _onDtmfEntryComplete(ep, dtmfEntry) {
    this.logger.info(`collected dtmf entry: ${dtmfEntry}`);
    this.dtmfEntry = dtmfEntry;
    this.digitBuffer = null;
    // if a final transcription, start a typing sound
    if (this.thinkingMusic) {
      ep.play(this.thinkingMusic).catch((err) => this.logger.info(err, 'Error playing typing sound'));
    }

    // kill the current dialogflow, which will result in us getting an immediate intent
    ep.api('dialogflow_stop', `${ep.uuid}`)
      .catch((err) => this.logger.info(`dialogflow_stop failed: ${err.message}`));
  }

  /**
   * The user has not provided any input for some time.
   * Set the 'noinput' member to true and kill the current dialogflow.
   * This will result in us re-prompting with an event indicating no input.
   * @param {*} ep
   */
  _onNoInput(ep, cs) {
    this.noinput = true;

    if (this.events.includes('no-input')) {
      this._performHook(cs, this.eventHook,  {event: 'no-input'});
    }

    // kill the current dialogflow, which will result in us getting an immediate intent
    ep.api('dialogflow_stop', `${ep.uuid}`)
      .catch((err) => this.logger.info(`dialogflow_stop failed: ${err.message}`));
  }

  /**
   * Stop the no-input timer, if it is running
   */
  _clearNoinputTimer() {
    if (this.noinputTimer) {
      clearTimeout(this.noinputTimer);
      this.noinputTimer = null;
    }
  }

  /**
   * Start the no-input timer.  The duration is set in the configuration file.
   * @param {*} ep
   */
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
          this.logger.info({tasks: tasks},
            `${this.name} replacing application with ${tasks.length} tasks after play completes`);
          return;
        }
        this._redirect(cs, tasks);
      }
    }
  }

  _redirect(cs, tasks) {
    this.logger.info({tasks: tasks}, `${this.name} replacing application with ${tasks.length} tasks`);
    this.performAction({dialogflowResult: 'redirect'}, false);
    this.reportedFinalAction = true;
    cs.replaceApplication(tasks);
  }

}

module.exports = Dialogflow;
