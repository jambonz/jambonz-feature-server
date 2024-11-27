const Emitter = require('events');
const fs = require('fs');
const {
  CallDirection,
  MediaPath,
  TaskPreconditions,
  CallStatus,
  TaskName,
  KillReason,
  RecordState,
  AllowedSipRecVerbs,
  AllowedConfirmSessionVerbs
} = require('../utils/constants');
const moment = require('moment');
const assert = require('assert');
const sessionTracker = require('./session-tracker');
const makeTask = require('../tasks/make_task');
const parseDecibels = require('../utils/parse-decibels');
const { normalizeJambones } = require('@jambonz/verb-specifications');
const listTaskNames = require('../utils/summarize-tasks');
const HttpRequestor = require('../utils/http-requestor');
const WsRequestor = require('../utils/ws-requestor');
const ActionHookDelayProcessor = require('../utils/action-hook-delay');
const {parseUri} = require('drachtio-srf');
const {
  JAMBONES_INJECT_CONTENT,
  JAMBONES_EAGERLY_PRE_CACHE_AUDIO,
  AWS_REGION,
  JAMBONES_USE_FREESWITCH_TIMER_FD
} = require('../config');
const bent = require('bent');
const BackgroundTaskManager = require('../utils/background-task-manager');
const dbUtils = require('../utils/db-utils');
const BADPRECONDITIONS = 'preconditions not met';
const CALLER_CANCELLED_ERR_MSG = 'Response not sent due to unknown transaction';

const sqlRetrieveQueueEventHook = `SELECT * FROM webhooks 
WHERE webhook_sid = 
(
  SELECT queue_event_hook_sid FROM accounts where account_sid = ?
)`;

/**
 * @classdesc Represents the execution context for a call.
 * It holds the resources, such as the sip dialog and media server endpoint
 * that are needed by Tasks that are operating on the call.<br/><br/>
 * CallSession is a superclass object that is extended by specific types
 * of sessions, such as InboundCallSession, RestCallSession and others.
 */
class CallSession extends Emitter {
  /**
   *
   * @param {object} opts
   * @param {logger} opts.logger - a pino logger
   * @param {object} opts.application - the application to execute
   * @param {Srf} opts.srf - the Srf instance
   * @param {array} opts.tasks - tasks we are to execute
   * @param {callInfo} opts.callInfo - information about the call
   */
  constructor({logger, application, srf, tasks, callInfo, accountInfo, rootSpan, memberId, confName, confUuid}) {
    super();
    this.logger = logger;
    this.application = application;
    this.srf = srf;
    this.callInfo = callInfo;
    this.accountInfo = accountInfo;
    this.tasks = tasks;
    this.memberId = memberId;
    this.confName = confName;
    this.confUuid = confUuid;
    this.taskIdx = 0;
    this.stackIdx = 0;
    this.callGone = false;
    this.notifiedComplete = false;
    this.rootSpan = rootSpan;
    this.backgroundTaskManager = new BackgroundTaskManager({
      cs: this,
      logger,
      rootSpan
    });

    this._origRecognizerSettings = {
      vendor: this.application?.speech_recognizer_vendor,
      language: this.application?.speech_recognizer_language,
    };
    this._origSynthesizerSettings = {
      vendor: this.application?.speech_synthesis_vendor,
      language: this.application?.speech_synthesis_language,
      voice: this.application?.speech_synthesis_voice,
    };

    assert(rootSpan);

    this._recordState = RecordState.RecordingOff;
    this._notifyEvents = false;

    this.tmpFiles = new Set();

    if (!this.isSmsCallSession) {
      this.updateCallStatus = srf.locals.dbHelpers.updateCallStatus;
      this.serviceUrl = srf.locals.serviceUrl;
    }

    if (!this.isConfirmCallSession && !this.isSmsCallSession && !this.isAdultingCallSession) {
      sessionTracker.add(this.callSid, this);

      const {startAmd, stopAmd} = require('../utils/amd-utils')(logger);
      this.startAmd = startAmd;
      this.stopAmd = stopAmd;
    }

    this._pool = srf.locals.dbHelpers.pool;

    const handover = (newRequestor) => {
      this.logger.info(`handover to new base url ${newRequestor.url}`);
      this.requestor.removeAllListeners();
      this.application.requestor = newRequestor;
      this.requestor.on('command', this._onCommand.bind(this));
      this.logger.debug(`CallSession: ${this.callSid} listener count ${this.requestor.listenerCount('command')}`);
      this.requestor.on('connection-dropped', this._onWsConnectionDropped.bind(this));
      this.requestor.on('handover', handover.bind(this));
      this.requestor.on('reconnect-error', this._onSessionReconnectError.bind(this));
    };

    if (!this.isConfirmCallSession) {
      this.requestor.on('command', this._onCommand.bind(this));
      this.logger.debug(`CallSession: ${this.callSid} listener count ${this.requestor.listenerCount('command')}`);
      this.requestor.on('connection-dropped', this._onWsConnectionDropped.bind(this));
      this.requestor.on('handover', handover.bind(this));
      this.requestor.on('reconnect-error', this._onSessionReconnectError.bind(this));
    }
  }

  /**
   * callSid for the call being handled by the session
   */
  get callSid() {
    return this.callInfo.callSid;
  }

  /**
   * direction of the call: inbound or outbound
   */
  get direction() {
    return this.callInfo.direction;
  }

  get applicationSid() {
    return this.callInfo.applicationSid;
  }

  get callStatus() {
    return this.callInfo.callStatus;
  }

  get isBackGroundListen() {
    return this.backgroundTaskManager.isTaskRunning('listen');
  }

  /**
   * SIP call-id for the call
   */
  get callId() {
    return this.callInfo.callId;
  }

  /**
   * http endpoint to send call status updates to
   */
  get call_status_hook() {
    return this.application.call_status_hook;
  }

  /**
   * can be used for all http requests within this session
   */
  get requestor() {
    assert(this.application.requestor);
    return this.application.requestor;
  }

  /**
   * can be used for all http call status notifications within this session
   */
  get notifier() {
    assert(this.application.notifier);
    return this.application.notifier;
  }

  /**
   * syntheizer
   */

  get synthesizer() {
    return this._synthesizer;
  }

  set synthesizer(synth) {
    this._synthesizer = synth;
  }

  /**
   * ASR TTS fallback
   */
  get hasFallbackAsr() {
    return this._hasFallbackAsr || false;
  }

  set hasFallbackAsr(i) {
    this._hasFallbackAsr = i;
  }

  get hasFallbackTts() {
    return this._hasFallbackTts || false;
  }

  set hasFallbackTts(i) {
    this._hasFallbackTts = i;
  }
  /**
   * default vendor to use for speech synthesis if not provided in the app
   */
  get speechSynthesisVendor() {
    return this.application.speech_synthesis_vendor;
  }
  set speechSynthesisVendor(vendor) {
    this.application.speech_synthesis_vendor = vendor;
  }

  get fallbackSpeechSynthesisVendor() {
    return this.application.fallback_speech_synthesis_vendor;
  }
  set fallbackSpeechSynthesisVendor(vendor) {
    this.application.fallback_speech_synthesis_vendor = vendor;
  }

  /**
   * default label to use for speech synthesis if not provided in the app
   */
  get speechSynthesisLabel() {
    return this.application.speech_synthesis_label;
  }
  set speechSynthesisLabel(label) {
    this.application.speech_synthesis_label = label;
  }

  get fallbackSpeechSynthesisLabel() {
    return this.application.fallback_speech_synthesis_label;
  }
  set fallbackSpeechSynthesisLabel(label) {
    this.application.fallback_speech_synthesis_label = label;
  }
  /**
   * default voice to use for speech synthesis if not provided in the app
   */
  get speechSynthesisVoice() {
    return this.application.speech_synthesis_voice;
  }
  set speechSynthesisVoice(voice) {
    this.application.speech_synthesis_voice = voice;
  }

  get fallbackSpeechSynthesisVoice() {
    return this.application.fallback_speech_synthesis_voice;
  }
  set fallbackSpeechSynthesisVoice(voice) {
    this.application.fallback_speech_synthesis_voice = voice;
  }
  /**
   * default language to use for speech synthesis if not provided in the app
   */
  get speechSynthesisLanguage() {
    return this.application.speech_synthesis_language;
  }
  set speechSynthesisLanguage(language) {
    this.application.speech_synthesis_language = language;
  }

  get fallbackSpeechSynthesisLanguage() {
    return this.application.fallback_speech_synthesis_language;
  }
  set fallbackSpeechSynthesisLanguage(language) {
    this.application.fallback_speech_synthesis_language = language;
  }

  /**
   * default vendor to use for speech recognition if not provided in the app
   */
  get speechRecognizerVendor() {
    return this.application.speech_recognizer_vendor;
  }
  set speechRecognizerVendor(vendor) {
    this.application.speech_recognizer_vendor = vendor;
  }

  get fallbackSpeechRecognizerVendor() {
    return this.application.fallback_speech_recognizer_vendor;
  }
  set fallbackSpeechRecognizerVendor(vendor) {
    this.application.fallback_speech_recognizer_vendor = vendor;
  }
  /**
   * recognizer
   */
  get recognizer() {
    return this._recognizer;
  }

  set recognizer(rec) {
    this._recognizer = rec;
  }
  /**
   * default vendor to use for speech recognition if not provided in the app
   */
  get speechRecognizerLabel() {
    return this.application.speech_recognizer_label;
  }
  set speechRecognizerLabel(label) {
    this.application.speech_recognizer_label = label;
  }

  get fallbackSpeechRecognizerLabel() {
    return this.application.fallback_speech_recognizer_label;
  }
  set fallbackSpeechRecognizerLabel(label) {
    this.application.fallback_speech_recognizer_label = label;
  }
  /**
 * default language to use for speech recognition if not provided in the app
 */
  get speechRecognizerLanguage() {
    return this.application.speech_recognizer_language;
  }
  set speechRecognizerLanguage(language) {
    this.application.speech_recognizer_language = language;
  }

  get fallbackSpeechRecognizerLanguage() {
    return this.application.fallback_speech_recognizer_language;
  }
  set fallbackSpeechRecognizerLanguage(language) {
    this.application.fallback_speech_recognizer_language = language;
  }

  /**
   * global referHook
   */

  set referHook(hook) {
    this._referHook = hook;
  }

  get referHook() {
    return this._referHook;
  }

  /**
   * Vad
   */
  get vad() {
    return this._vad;
  }

  set vad(v) {
    this._vad = v;
  }

  /**
   * indicates whether the call currently in progress
   */
  get hasStableDialog() {
    return this.dlg && this.dlg.connected;
  }

  /**
   * indicates whether call is currently in a ringing state (ie not yet answered)
   */
  get isOutboundCallRinging() {
    return this.direction === CallDirection.Outbound && this.req && !this.dlg;
  }

  /**
   * returns true if the call is an inbound call and a final sip response has been sent
   */
  get isInboundCallAnswered() {
    return this.direction === CallDirection.Inbound && this.res.finalResponseSent;
  }

  /**
   * returns the account sid
   */
  get accountSid() {
    return this.callInfo.accountSid;
  }

  /**
   * returns true if this session was transferred from another server
   */
  get isTransferredCall() {
    return this.application.transferredCall === true;
  }

  /**
   * returns true if this session is a ConfirmCallSession
   */
  get isAdultingCallSession() {
    return this.constructor.name === 'AdultingCallSession';
  }

  /**
   * returns true if this session is a ConfirmCallSession
   */
  get isConfirmCallSession() {
    return this.constructor.name === 'ConfirmCallSession';
  }

  /**
   * returns true if this session is a SipRecCallSession
   */
  get isSipRecCallSession() {
    return this.constructor.name === 'SipRecCallSession';
  }

  /**
   * returns true if this session is a SmsCallSession
   */
  get isSmsCallSession() {
    return this.constructor.name === 'SmsCallSession';
  }

  get webhook_secret() {
    return this.accountInfo?.account?.webhook_secret;
  }

  get isInConference() {
    return this.memberId && this.confName && this.confUuid;
  }

  get isBotModeEnabled() {
    return this.backgroundTaskManager.isTaskRunning('bargeIn');
  }

  get isListenEnabled() {
    return this.backgroundTaskManager.isTaskRunning('listen');
  }

  get b3() {
    return this.rootSpan?.getTracingPropagation();
  }

  get recordState() { return this._recordState; }

  get notifyEvents() { return this._notifyEvents; }
  set notifyEvents(notify) { this._notifyEvents = !!notify; }

  set globalSttHints({hints, hintsBoost}) {
    this._globalSttHints = {hints, hintsBoost};
  }

  get hasGlobalSttHints() {
    const {hints = []} = this._globalSttHints || {};
    return hints.length > 0;
  }

  get globalSttHints() {
    return this._globalSttHints;
  }

  set altLanguages(langs) {
    this._globalAltLanguages = langs;
  }

  get hasAltLanguages() {
    return Array.isArray(this._globalAltLanguages);
  }

  get altLanguages() {
    return this._globalAltLanguages;
  }

  set globalSttPunctuation(punctuate) {
    this._globalSttPunctuation = punctuate;
  }

  get globalSttPunctuation() {
    return this._globalSttPunctuation;
  }

  get onHoldMusic() {
    return this._onHoldMusic;
  }

  set onHoldMusic(url) {
    this._onHoldMusic = url;
  }

  get sipRequestWithinDialogHook() {
    return this._sipRequestWithinDialogHook;
  }

  set sipRequestWithinDialogHook(url) {
    this._sipRequestWithinDialogHook = url;
  }

  // Bot Delay (actionHook delayed)
  get actionHookDelayEnabled() {
    return this._actionHookDelayEnabled;
  }

  set actionHookDelayEnabled(e) {
    this._actionHookDelayEnabled = e;
  }

  get actionHookNoResponseTimeout() {
    return this._actionHookNoResponseTimeout;
  }

  set actionHookNoResponseTimeout(e) {
    this._actionHookNoResponseTimeout = e;
  }

  get actionHookNoResponseGiveUpTimeout() {
    return this._actionHookNoResponseGiveUpTimeout;
  }

  set actionHookNoResponseGiveUpTimeout(e) {
    this._actionHookNoResponseGiveUpTimeout = e;
  }

  get actionHookDelayRetries() {
    return this._actionHookDelayRetries;
  }

  set actionHookDelayRetries(e) {
    this._actionHookDelayRetries = e;
  }

  get actionHookDelayProcessor() {
    return this._actionHookDelayProcessor;
  }

  set actionHookDelayProperties(opts) {
    if (this._actionHookDelayProcessor) {
      this._actionHookDelayProcessor.stop();
      if (!this._actionHookDelayProcessor.init(opts)) {
        this._actionHookDelayProcessor.removeAllListeners();
        this._actionHookDelayProcessor = null;
      }
    }
    else {
      try {
        this._actionHookDelayProcessor = new ActionHookDelayProcessor(this.logger, opts, this, this.ep);
        this._actionHookDelayProcessor.on('giveup', () => {
          this.logger.info('CallSession: ActionHookDelayProcessor: giveup event - hanging up call');
          this._jambonzHangup();
          if (this.wakeupResolver) {
            this.logger.debug('CallSession: Giveup timer expired - waking up');
            this.wakeupResolver({reason: 'noResponseGiveUp'});
            this.wakeupResolver = null;
          }
        });
        this._actionHookDelayProcessor.on('giveupWithTasks', (tasks) => {
          this.logger.info('CallSession: ActionHookDelayProcessor: giveupWithTasks event');
          const giveUpTasks = normalizeJambones(this.logger, tasks).map((tdata) => makeTask(this.logger, tdata));
          this.logger.info({tasks: listTaskNames(giveUpTasks)}, 'CallSession:giveupWithTasks task list');

          // we need to clear the ahd, as we do not want to execute actionHookDelay actions again
          this.clearActionHookDelayProcessor();

          // replace the application with giveUpTasks
          this.replaceApplication(giveUpTasks);
        });
      } catch (err) {
        this.logger.error({err}, 'CallSession: Error creating ActionHookDelayProcessor');
      }
    }
  }

  async clearOrRestoreActionHookDelayProcessor() {
    if (this._actionHookDelayProcessor) {
      await this._actionHookDelayProcessor.stop();
      if (!this.popActionHookDelayProperties()) {
        //this.logger.debug('CallSession:clearOrRestoreActionHookDelayProcessor - ahd settings');
        //await this.clearActionHookDelayProcessor();
      }
      this.logger.debug('CallSession:clearOrRestoreActionHookDelayProcessor - say or play action completed');
    }
  }

  async clearActionHookDelayProcessor() {
    if (this._actionHookDelayProcessor) {
      await this._actionHookDelayProcessor.stop();
      this._actionHookDelayProcessor.removeAllListeners();
      this._actionHookDelayProcessor = null;
    }
  }

  stashActionHookDelayProperties() {
    this._storedActionHookDelayProperties = this._actionHookDelayProcessor.properties;
  }

  popActionHookDelayProperties() {
    if (this._storedActionHookDelayProperties) {
      this._actionHookDelayProcessor.init(this._storedActionHookDelayProperties);
      this._storedActionHookDelayProperties = null;
      return true;
    }
    return false;
  }


  hasGlobalSttPunctuation() {
    return this._globalSttPunctuation !== undefined;
  }

  resetRecognizer() {
    this._globalSttHints = undefined;
    this._globalSttPunctuation = undefined;
    this._globalAltLanguages = undefined;
    this.isContinuousAsr = false;
    this.asrDtmfTerminationDigits = undefined;
    this.speechRecognizerLanguage = this._origRecognizerSettings.language;
    this.speechRecognizerVendor = this._origRecognizerSettings.vendor;
  }

  resetSynthesizer() {
    this.speechSynthesisLanguage = this._origSynthesizerSettings.language;
    this.speechSynthesisVendor = this._origSynthesizerSettings.vendor;
    this.speechSynthesisVoice = this._origSynthesizerSettings.voice;
  }

  enableFillerNoise(opts) {
    this._fillerNoise = opts;
  }

  disableFillerNoise() {
    this._fillerNoise = null;
  }

  get fillerNoise() {
    return this._fillerNoise;
  }

  async notifyRecordOptions(opts) {
    const {action} = opts;
    this.logger.debug({opts}, 'CallSession:notifyRecordOptions');

    /* if we have not answered yet, just save the details for later */
    if (!this.dlg) {
      if (action === 'startCallRecording') {
        this.recordOptions = opts;
        return true;
      }
      return false;
    }

    /* check validity of request */
    if (action == 'startCallRecording' && this.recordState !== RecordState.RecordingOff) {
      this.logger.info({recordState: this.recordState},
        'CallSession:notifyRecordOptions: recording is already started, ignoring request');
      return false;
    }
    if (action == 'stopCallRecording' && this.recordState === RecordState.RecordingOff) {
      this.logger.info({recordState: this.recordState},
        'CallSession:notifyRecordOptions: recording is already stopped, ignoring request');
      return false;
    }
    if (action == 'pauseCallRecording' && this.recordState !== RecordState.RecordingOn) {
      this.logger.info({recordState: this.recordState},
        'CallSession:notifyRecordOptions: cannot pause recording, ignoring request ');
      return false;
    }
    if (action == 'resumeCallRecording' && this.recordState !== RecordState.RecordingPaused) {
      this.logger.info({recordState: this.recordState},
        'CallSession:notifyRecordOptions: cannot resume recording, ignoring request ');
      return false;
    }

    this.recordOptions = opts;

    switch (action) {
      case 'startCallRecording':
        return await this.startRecording();
      case 'stopCallRecording':
        return await this.stopRecording();
      case 'pauseCallRecording':
        return await this.pauseRecording();
      case 'resumeCallRecording':
        return await this.resumeRecording();
      default:
        throw new Error(`invalid record action ${action}`);
    }
  }

  async startRecording() {
    const {recordingID, siprecServerURL} = this.recordOptions;
    assert(this.dlg);
    this.logger.debug(`CallSession:startRecording - sending to ${siprecServerURL}`);
    try {
      const res = await this.dlg.request({
        method: 'INFO',
        headers: {
          'X-Reason': 'startCallRecording',
          'X-Srs-Url': siprecServerURL,
          'X-Srs-Recording-ID': recordingID,
          'X-Call-Sid': this.callSid,
          'X-Account-Sid': this.accountSid,
          'X-Application-Sid': this.applicationSid,
          ...(this.recordOptions.headers && {'Content-Type': 'application/json'})
        },
        // Siprect Client is initiated from startCallRecording, so just need to pass custom headers in startRecording
        ...(this.recordOptions.headers && {body: JSON.stringify(this.recordOptions.headers) + '\n'})
      });
      if (res.status === 200) {
        this._recordState = RecordState.RecordingOn;
        return true;
      }
      this.logger.info(`CallSession:startRecording - ${res.status} failure sending to ${siprecServerURL}`);
      return false;
    } catch (err) {
      this.logger.info({err}, `CallSession:startRecording - failure sending to ${siprecServerURL}`);
      return false;
    }
  }

  async stopRecording() {
    assert(this.dlg);
    this.logger.debug('CallSession:stopRecording');
    try {
      const res = await this.dlg.request({
        method: 'INFO',
        headers: {
          'X-Reason': 'stopCallRecording'
        }
      });
      if (res.status === 200) {
        this._recordState = RecordState.RecordingOff;
        return true;
      }
      this.logger.info(`CallSession:stopRecording - ${res.status} failure`);
      return false;
    } catch (err) {
      this.logger.info({err}, 'CallSession:startRecording - failure sending');
      return false;
    }
  }

  async pauseRecording() {
    assert(this.dlg);
    this.logger.debug('CallSession:pauseRecording');
    try {
      const res = await this.dlg.request({
        method: 'INFO',
        headers: {
          'X-Reason': 'pauseCallRecording',
          ...(this.recordOptions.headers && {'Content-Type': 'application/json'})
        },
        ...(this.recordOptions.headers && {body: JSON.stringify(this.recordOptions.headers) + '\n'})
      });
      if (res.status === 200) {
        this._recordState = RecordState.RecordingPaused;
        return true;
      }
      this.logger.info(`CallSession:pauseRecording - ${res.status} failure`);
      return false;
    } catch (err) {
      this.logger.info({err}, 'CallSession:pauseRecording - failure sending');
      return false;
    }
  }

  async resumeRecording() {
    assert(this.dlg);
    this.logger.debug('CallSession:resumeRecording');
    try {
      const res = await this.dlg.request({
        method: 'INFO',
        headers: {
          'X-Reason': 'resumeCallRecording',
          ...(this.recordOptions.headers && {'Content-Type': 'application/json'})
        },
        ...(this.recordOptions.headers && {body: JSON.stringify(this.recordOptions.headers) + '\n'})
      });
      if (res.status === 200) {
        this._recordState = RecordState.RecordingOn;
        return true;
      }
      this.logger.info(`CallSession:resumeRecording - ${res.status} failure`);
      return false;
    } catch (err) {
      this.logger.info({err}, 'CallSession:resumeRecording - failure sending');
      return false;
    }
  }

  async enableBotMode(gather, autoEnable) {
    try {
      let task;
      if (this.isBotModeEnabled) {
        task = this.backgroundTaskManager.getTask('bargeIn');
        const currInput = task.input;
        const t = normalizeJambones(this.logger, [gather]);
        const tmpTask = makeTask(this.logger, t[0]);
        const newInput = tmpTask.input;
        if (JSON.stringify(currInput) === JSON.stringify(newInput)) {
          this.logger.info('CallSession:enableBotMode - bot mode currently enabled, ignoring request to start again');
          return;
        } else {
          this.logger.info({currInput, newInput},
            'CallSession:enableBotMode - restarting background bargeIn to apply new input type');
          task.sticky = false;
          await this.disableBotMode();
        }
      }
      task = await this.backgroundTaskManager.newTask('bargeIn', gather);
      task.sticky = autoEnable;
      // listen to the bargein-done from background manager
      this.backgroundTaskManager.on('bargeIn-done', () => {
        if (this.requestor instanceof WsRequestor) {
          try {
            this.kill(true);
          } catch (err) {}
        }
      });
      this.logger.info({gather}, 'CallSession:enableBotMode - starting background bargeIn');
    } catch (err) {
      this.logger.info({err, gather}, 'CallSession:enableBotMode - Error creating bargeIn task');
    }
  }
  async disableBotMode() {
    const task = this.backgroundTaskManager.getTask('bargeIn');
    if (task) task.sticky = false;
    this.backgroundTaskManager.stop('bargeIn');
  }

  setConferenceDetails(memberId, confName, confUuid) {
    assert(!this.memberId && !this.confName && !this.confUuid);
    assert (memberId && confName && confUuid);

    this.logger.debug(`session is now in conference ${confName}:${memberId} - uuid ${confUuid}`);
    this.memberId = memberId;
    this.confName = confName;
    this.confUuid = confUuid;
  }

  clearConferenceDetails() {
    this.logger.debug(`session has now left conference ${this.confName}:${this.memberId}`);
    this.memberId = null;
    this.confName = null;
    this.confUuid = null;
  }

  /**
   * Check for speech credentials for the specified vendor
   * @param {*} vendor - google or aws
   */
  getSpeechCredentials(vendor, type, label = null) {
    const {writeAlerts, AlertType} = this.srf.locals;
    if (this.accountInfo.speech && this.accountInfo.speech.length > 0) {
      // firstly check if account level has expected credential
      let credential = this.accountInfo.speech.find((s) => s.vendor === vendor &&
        s.label === label && s.account_sid);
      if (!credential) {
        // check if SP level has expected credential
        credential = this.accountInfo.speech.find((s) => s.vendor === vendor &&
        s.label === label && !s.account_sid);
      }
      if (credential && (
        (type === 'tts' && credential.use_for_tts) ||
        (type === 'stt' && credential.use_for_stt)
      )) {
        this.logger.info(
          `${type}: ${credential.vendor} ${credential.label ? `, label: ${credential.label}` : ''}  `);
        if ('google' === vendor) {
          if (type === 'tts' && !credential.tts_tested_ok ||
            type === 'stt' && !credential.stt_tested_ok) {
            return;
          }
          try {
            const cred = JSON.parse(credential.service_key.replace(/\n/g, '\\n'));
            return {
              speech_credential_sid: credential.speech_credential_sid,
              credentials: cred
            };
          } catch (err) {
            const sid = this.accountInfo.account.account_sid;
            this.logger.info({err}, `malformed google service_key provisioned for account ${sid}`);
            writeAlerts({
              alert_type: AlertType.TTS_FAILURE,
              account_sid: this.accountSid,
              vendor,
              target_sid: this.callSid
            }).catch((err) => this.logger.error({err}, 'Error writing tts alert'));
          }
        }
        else if (['aws', 'polly'].includes(vendor)) {
          return {
            speech_credential_sid: credential.speech_credential_sid,
            accessKeyId: credential.access_key_id,
            secretAccessKey: credential.secret_access_key,
            roleArn: credential.role_arn,
            region: credential.aws_region || AWS_REGION
          };
        }
        else if ('microsoft' === vendor) {
          return {
            speech_credential_sid: credential.speech_credential_sid,
            api_key: credential.api_key,
            region: credential.region,
            use_custom_stt: credential.use_custom_stt,
            custom_stt_endpoint: credential.custom_stt_endpoint,
            custom_stt_endpoint_url: credential.custom_stt_endpoint_url,
            use_custom_tts: credential.use_custom_tts,
            custom_tts_endpoint: credential.custom_tts_endpoint,
            custom_tts_endpoint_url: credential.custom_tts_endpoint_url
          };
        }
        else if ('wellsaid' === vendor) {
          return {
            speech_credential_sid: credential.speech_credential_sid,
            api_key: credential.api_key
          };
        }
        else if ('nuance' === vendor) {
          return {
            speech_credential_sid: credential.speech_credential_sid,
            client_id: credential.client_id,
            secret: credential.secret,
            nuance_tts_uri: credential.nuance_tts_uri,
            nuance_stt_uri: credential.nuance_stt_uri
          };
        }
        else if ('deepgram' === vendor) {
          return {
            speech_credential_sid: credential.speech_credential_sid,
            api_key: credential.api_key,
            deepgram_stt_uri: credential.deepgram_stt_uri,
            deepgram_tts_uri: credential.deepgram_tts_uri,
            deepgram_stt_use_tls: credential.deepgram_stt_use_tls
          };
        }
        else if ('soniox' === vendor) {
          return {
            speech_credential_sid: credential.speech_credential_sid,
            api_key: credential.api_key
          };
        }
        else if ('ibm' === vendor) {
          return {
            speech_credential_sid: credential.speech_credential_sid,
            tts_api_key: credential.tts_api_key,
            tts_region: credential.tts_region,
            stt_api_key: credential.stt_api_key,
            stt_region: credential.stt_region
          };
        }
        else if ('nvidia' === vendor) {
          return {
            speech_credential_sid: credential.speech_credential_sid,
            riva_server_uri: credential.riva_server_uri
          };
        }
        else if ('cobalt' === vendor) {
          return {
            speech_credential_sid: credential.speech_credential_sid,
            cobalt_server_uri: credential.cobalt_server_uri
          };
        }
        else if ('elevenlabs' === vendor) {
          return {
            api_key: credential.api_key,
            model_id: credential.model_id,
            options: credential.options
          };
        }
        else if ('playht' === vendor) {
          return {
            api_key: credential.api_key,
            user_id: credential.user_id,
            voice_engine: credential.voice_engine,
            options: credential.options
          };
        }
        else if ('rimelabs' === vendor) {
          return {
            api_key: credential.api_key,
            model_id: credential.model_id,
            options: credential.options
          };
        }
        else if ('assemblyai' === vendor) {
          return {
            speech_credential_sid: credential.speech_credential_sid,
            api_key: credential.api_key
          };
        }
        else if ('whisper' === vendor) {
          return {
            api_key: credential.api_key,
            model_id: credential.model_id
          };
        }
        else if ('verbio' === vendor) {
          return {
            client_id: credential.client_id,
            client_secret: credential.client_secret,
            engine_version: credential.engine_version
          };
        }
        else if ('speechmatics' === vendor) {
          this.logger.info({credential}, 'CallSession:getSpeechCredentials - speechmatics credential');
          return {
            api_key: credential.api_key,
            speechmatics_stt_uri: credential.speechmatics_stt_uri,
          };
        }
        else if (vendor.startsWith('custom:')) {
          return {
            speech_credential_sid: credential.speech_credential_sid,
            auth_token: credential.auth_token,
            custom_stt_url: credential.custom_stt_url,
            custom_tts_url: credential.custom_tts_url
          };
        }
      }
      else {
        writeAlerts({
          alert_type: AlertType.STT_NOT_PROVISIONED,
          account_sid: this.accountSid,
          vendor,
          target_sid: this.callSid
        }).catch((err) => this.logger.error({err}, 'Error writing tts alert'));
      }
    }
  }

  /**
   * execute the tasks in the CallSession.  The tasks are executed in sequence until
   * they complete, or the caller hangs up.
   * @async
   */
  async exec() {
    this.logger.info({tasks: listTaskNames(this.tasks)}, `CallSession:exec starting ${this.tasks.length} tasks`);

    // calculate if inbandDTMF tone is used
    const voip_carrier_sid = this.req.has('X-Voip-Carrier-Sid') ? this.req.get('X-Voip-Carrier-Sid') :
      this.req.has('X-Requested-Carrier-Sid') ? this.req.get('X-Requested-Carrier-Sid') : null;

    if (voip_carrier_sid) {
      const {lookupVoipCarrierBySid} = dbUtils(this.logger, this.srf);
      const [voipCarrier] = await lookupVoipCarrierBySid(voip_carrier_sid);
      this.inbandDtmfEnabled = voipCarrier?.dtmf_type === 'tones';
    }

    while (this.tasks.length && !this.callGone) {
      const taskNum = ++this.taskIdx;
      const stackNum = this.stackIdx;
      const task = this.tasks.shift();
      this.logger.info(`CallSession:exec starting task #${stackNum}:${taskNum}: ${task.name}`);
      this._notifyTaskStatus(task, {event: 'starting'});
      // Register verbhook span wait for end
      task.on('VerbHookSpanWaitForEnd', ({span}) => {
        this.verbHookSpan = span;
      });
      try {
        const resources = await this._evaluatePreconditions(task);
        let skip = false;
        this.currentTask = task;
        if (TaskName.Gather === task.name && this.isBotModeEnabled) {
          if (this.backgroundTaskManager.getTask('bargeIn').updateTaskInProgress(task) !== false) {
            this.logger.info(`CallSession:exec skipping #${stackNum}:${taskNum}: ${task.name}`);
            skip = true;
          }
          else {
            this.logger.info('CallSession:exec disabling bot mode to start gather with new options');
            await this.disableBotMode();
          }
        }
        if (!skip) {
          const {span, ctx} = this.rootSpan.startChildSpan(`verb:${task.summary}`);
          span.setAttributes({'verb.summary': task.summary});
          task.span = span;
          task.ctx = ctx;
          await task.exec(this, resources);
          task.span.end();
        }
        this.currentTask = null;
        this.logger.info(`CallSession:exec completed task #${stackNum}:${taskNum}: ${task.name}`);
        this._notifyTaskStatus(task, {event: 'finished'});
      } catch (err) {
        task.span?.end();
        this.currentTask = null;
        if (err.message?.includes(BADPRECONDITIONS)) {
          this.logger.info(`CallSession:exec task #${stackNum}:${taskNum}: ${task.name}: ${err.message}`);
        }
        else {
          this.logger.error(err, `Error executing task  #${stackNum}:${taskNum}: ${task.name}`);
          break;
        }
      }

      if (0 === this.tasks.length &&
        this.requestor instanceof WsRequestor &&
        !this.requestor.closedGracefully &&
        !this.callGone &&
        !this.isConfirmCallSession
      ) {
        try {
          await this._awaitCommandsOrHangup();

          //await this.clearOrRestoreActionHookDelayProcessor();

          //TODO: remove filler noise code and simply create as action hook delay
          if (this._isPlayingFillerNoise) {
            this._isPlayingFillerNoise = false;
            this.ep.api('uuid_break', this.ep.uuid)
              .catch((err) => this.logger.info(err, 'Error killing filler noise'));
          }
          if (this.callGone) break;
        } catch (err) {
          this.logger.info(err, 'CallSession:exec - error waiting for new commands');
          break;
        }
      }
    }

    // all done - cleanup
    this.logger.info('CallSession:exec all tasks complete');
    this._stopping = true;
    this._onTasksDone();
    this._clearResources();


    if (!this.isConfirmCallSession && !this.isSmsCallSession) sessionTracker.remove(this.callSid);
  }

  trackTmpFile(path) {
    // TODO: don't add if its already in the list (should we make it a set?)
    this.tmpFiles.add(path);
  }

  normalizeUrl(url, method, auth) {
    const hook = {
      url,
      method
    };
    if (auth && auth.username && auth.password) {
      hook.auth = {
        username: auth.username,
        password: auth.password
      };
    }
    if (typeof url === 'string' && url.startsWith('/')) {
      const baseUrl = this.requestor.baseUrl;
      hook.url = `${baseUrl}${url}`;
      if (this.requestor.username && this.requestor.password) {
        hook.auth = {
          username: this.requestor.username,
          password: this.requestor.password
        };
      }
    }
    return hook;
  }
  /**
   * This is called when all tasks have completed.  It is not implemented in the superclass
   * but provided as a convenience for subclasses that need to do cleanup at the end of
   * the call session.
   */
  _onTasksDone() {
    // meant to be implemented by subclass if needed
  }

  /**
   * this is called to clean up when the call is released from one side or another
   */
  _callReleased() {
    this.callGone = true;
    if (this.currentTask) {
      this.currentTask.kill(this);
      this.currentTask = null;
    }
    if (this.wakeupResolver) {
      this.wakeupResolver({reason: 'session ended'});
      this.wakeupResolver = null;
    }
  }

  /**
   * perform live call control - update call status
   * @param {obj} opts
   * @param {string} opts.call_status - 'complete' or 'no-answer'
   */
  _lccCallStatus(opts) {
    if (opts.call_status === CallStatus.Completed && this.dlg) {
      this.logger.info('CallSession:_lccCallStatus hanging up call due to request from api');
      this._callerHungup();
    }
    else if (opts.call_status === CallStatus.NoAnswer) {
      if (this.direction === CallDirection.Inbound) {
        if (this.res && !this.res.finalResponseSent) {
          this.res.send(503);
          this._callReleased();
        }
      }
      else {
        if (this.req && !this.dlg) {
          this.req.cancel();
          this._callReleased();
        }
      }
    }
  }

  /**
   * perform live call control - create rest:dial
   * @param {obj} opts create call options
   */
  async _lccCallDial(opts) {
    try {
      const restDialUrl = `${this.srf.locals.serviceUrl}/v1/createCall`;
      await this.transformInputIfRequired(opts);
      const resp = bent('POST', 'json', 201)(restDialUrl, opts);
      this.logger.info(resp.body, 'successfully create outbound call');
      return resp.body;
    } catch (err) {
      if (err.json) {
        err.body = await err.json();
      }
      this.logger.error(err, 'failed to create outbound call from ' + this.callSid);
      this._notifyTaskError(err.body);
    }
  }

  async transformInputIfRequired(opts) {
    const {
      lookupAppBySid
    }  = this.srf.locals.dbHelpers;
    opts.account_sid = this.accountSid;

    if (opts.application_sid) {
      this.logger.debug(`Callsession:_validateCreateCall retrieving application ${opts.application_sid}`);
      const application = await lookupAppBySid(opts.application_sid);
      Object.assign(opts, {
        call_hook: application.call_hook,
        app_json: application.app_json,
        call_status_hook: application.call_status_hook,
        speech_synthesis_vendor: application.speech_synthesis_vendor,
        speech_synthesis_language: application.speech_synthesis_language,
        speech_synthesis_voice: application.speech_synthesis_voice,
        speech_recognizer_vendor: application.speech_recognizer_vendor,
        speech_recognizer_language: application.speech_recognizer_language
      });
      this.logger.debug({opts, application}, 'Callsession:_validateCreateCall augmented with application settings');
    }

    if (typeof opts.call_hook === 'string') {
      const url = opts.call_hook;
      opts.call_hook = {
        url,
        method: 'POST'
      };
    }
    if (typeof opts.call_status_hook === 'string') {
      const url = opts.call_status_hook;
      opts.call_status_hook = {
        url,
        method: 'POST'
      };
    }
  }

  /**
   * perform live call control -- set a new call_hook
   * @param {object} opts
   * @param {object} opts.call_hook - new call_hook to transfer to
   * @param {object} [opts.call_hook] - new call_status_hook
   */
  async _lccCallHook(opts) {
    const webhooks = [];
    let sd, tasks, childTasks;
    const b3 = this.b3;
    const httpHeaders = b3 && {b3};

    if (opts.call_hook || opts.child_call_hook) {
      if (opts.call_hook) {
        webhooks.push(this.requestor.request('session:redirect', opts.call_hook, this.callInfo.toJSON(), httpHeaders));
      }
      if (opts.child_call_hook) {
        /* child call hook only allowed from a connected Dial state */
        const task = this.currentTask;
        sd = task.sd;
        if (task && TaskName.Dial === task.name && sd) {
          webhooks.push(this.requestor.request(
            'session:redirect', opts.child_call_hook, sd.callInfo.toJSON(), httpHeaders));
        }
      }
      const [tasks1, tasks2] = await Promise.all(webhooks);
      if (opts.call_hook) {
        tasks = tasks1;
        if (opts.child_call_hook) childTasks = tasks2;
      }
      else childTasks = tasks1;
    }
    else if (opts.parent_call || opts.child_call) {
      const {parent_call, child_call} = opts;
      assert.ok(!parent_call || Array.isArray(parent_call), 'CallSession:_lccCallHook - parent_call must be an array');
      assert.ok(!child_call || Array.isArray(child_call), 'CallSession:_lccCallHook - child_call must be an array');
      tasks = parent_call;
      childTasks = child_call;
    }

    if (childTasks) {
      const {parentLogger} = this.srf.locals;
      const childLogger = parentLogger.child({callId: this.callId, callSid: sd.callSid});
      const t = normalizeJambones(childLogger, childTasks).map((tdata) => makeTask(childLogger, tdata));
      childLogger.info({tasks: listTaskNames(t)}, 'CallSession:_lccCallHook new task list for child call');

      // TODO: if using websockets api, we need a new websocket for the adulting session..
      const cs = await sd.doAdulting({
        logger: childLogger,
        application: this.application,
        tasks: t
      });

      /* need to update the callSid of the child with its own (new) AdultingCallSession */
      sessionTracker.add(cs.callSid, cs);
    }
    if (tasks) {
      const t = normalizeJambones(this.logger, tasks).map((tdata) => makeTask(this.logger, tdata));
      this.logger.info({tasks: listTaskNames(t)}, 'CallSession:_lccCallHook new task list');
      this.replaceApplication(t);
      if (this.wakeupResolver) {
        //this.logger.debug({resolution}, 'CallSession:_onCommand - got commands, waking up..');
        this.wakeupResolver({reason: 'lcc: new tasks'});
        this.wakeupResolver = null;
      }
    }
    else {
      /* we started a new app on the child leg, but nothing given for parent so hang him up */
      this.currentTask.kill(this);
    }
    this._endVerbHookSpan();

    await this.clearOrRestoreActionHookDelayProcessor();
  }

  /**
   * perform live call control -- change listen status
   * @param {object} opts
   * @param {string} opts.listen_status - 'pause' or 'resume'
  */
  async _lccListenStatus(opts) {
    const task = this.currentTask;
    if (!task || ![TaskName.Dial, TaskName.Listen].includes(task.name)) {
      return this.logger.info(`CallSession:_lccListenStatus - invalid listen_status in task ${task.name}`);
    }
    const listenTask = task.name === TaskName.Listen ? task : task.listenTask;
    if (!listenTask) {
      return this.logger.info('CallSession:_lccListenStatus - invalid listen_status: Dial does not have a listen');
    }
    listenTask.updateListen(opts.listen_status);
  }

  /**
   * perform live call control -- change Transcribe status
   * @param {object} opts
   * @param {string} opts.transcribe_status - 'pause' or 'resume'
  */
  async _lccTranscribeStatus(opts) {
    if (this.backgroundTaskManager.isTaskRunning('transcribe')) {
      this.backgroundTaskManager.getTask('transcribe').updateTranscribe(opts.transcribe_status);
    }
    const task = this.currentTask;
    if (!task || ![TaskName.Dial, TaskName.Transcribe].includes(task.name)) {
      return this.logger.info(`CallSession:_lccTranscribeStatus - invalid transcribe_status in task ${task.name}`);
    }
    const transcribeTask = task.name === TaskName.Transcribe ? task : task.transcribeTask;
    if (!transcribeTask) {
      return this.logger
        .info('CallSession:_lccTranscribeStatus - invalid transcribe_status: Dial does not have a Transcribe');
    }
    transcribeTask.updateTranscribe(opts.transcribe_status);
  }

  /**
   * perform live call control -- update customer data
   * @param {object} opts
   * @param {object} opts.tag - customer data
  */
  _lccTag(opts) {
    const {tag} = opts;
    if (typeof tag !== 'object' || Array.isArray(tag) || tag === null) {
      this.logger.info('CallSession:_lccTag - invalid tag data');
      return;
    }
    this.logger.debug({customerData: tag}, 'CallSession:_lccTag set customer data in callInfo');
    this.callInfo.customerData = tag;
  }

  async _lccConferenceParticipantAction(opts) {
    const task = this.currentTask;
    if (!task || TaskName.Conference !== task.name || !this.isInConference) {
      return this.logger.info('CallSession:_lccConferenceParticipantAction - invalid cmd, call is not in conference');
    }
    task.doConferenceParticipantAction(this, opts);
  }

  async _lccMuteStatus(mute, callSid) {
    // this whole thing requires us to be in a Dial or Conference verb
    const task = this.currentTask;
    if (!task || ![TaskName.Dial, TaskName.Conference].includes(task.name)) {
      return this.logger.info('CallSession:_lccMuteStatus - invalid: neither dial nor conference are not active');
    }
    // now do the mute/unmute
    task.mute(callSid, mute).catch((err) => this.logger.error(err, 'CallSession:_lccMuteStatus'));
  }

  async _lccConfHoldStatus(opts) {
    const task = this.currentTask;
    if (!task || TaskName.Conference !== task.name || !this.isInConference) {
      return this.logger.info('CallSession:_lccConfHoldStatus - invalid command as call is not in conference');
    }
    task.doConferenceHold(this, opts);
  }

  async _lccConfMuteStatus(opts) {
    const task = this.currentTask;
    if (!task || TaskName.Conference !== task.name || !this.isInConference) {
      return this.logger.info('CallSession:_lccConfHoldStatus - invalid command as call is not in conference');
    }
    task.doConferenceMuteNonModerators(this, opts);
  }

  async _lccSipRequest(opts, callSid) {
    const {sip_request} = opts;
    const {method, content_type, content, headers = {}} = sip_request;
    if (!this.hasStableDialog) {
      this.logger.info('CallSession:_lccSipRequest - invalid command as we do not have a stable call');
      return;
    }
    try {
      const dlg = callSid === this.callSid ? this.dlg : this.currentTask.dlg;
      const res = await dlg.request({
        method,
        headers: {
          ...headers,
          'Content-Type': content_type
        },
        body: content
      });
      this.logger.debug({res}, `CallSession:_lccSipRequest got response to ${method}`);
      return res;
    } catch (err) {
      this.logger.error({err}, `CallSession:_lccSipRequest - error sending ${method}`);
    }
  }

  /**
   * perform live call control - send RFC 2833 DTMF
   * @param {obj} opts
   * @param {string} opts.dtmf.digit - DTMF digit
   * @param {string} opts.dtmf.duration - Optional, Duration
   */
  async _lccDtmf(opts, callSid) {
    const {dtmf} = opts;
    const {digit, duration = 250} = dtmf;
    if (!this.hasStableDialog) {
      this.logger.info('CallSession:_lccDtmf - invalid command as we do not have a stable call');
      return;
    }
    try {
      const dlg = callSid === this.callSid ? this.dlg : this.currentTask.dlg;
      const res = await dlg.request({
        method: 'INFO',
        headers: {
          'Content-Type': 'application/dtmf',
          'X-Reason': 'Dtmf'
        },
        body: `Signal=${digit}
Duration=${duration} `
      });
      this.logger.debug({res}, `CallSession:_lccDtmf
 got response to INFO DTMF digit=${digit} and duration=${duration}`);
      return res;
    } catch (err) {
      this.logger.error({err}, 'CallSession:_lccDtmf - error sending INFO RFC 2833 DTMF');
    }
  }

  /**
   * perform live call control -- whisper to one party or the other on a call
   * @param {array} opts - array of play or say tasks
   */
  async _lccWhisper(opts, callSid) {
    const {whisper} = opts;
    let tasks;
    const b3 = this.b3;
    const httpHeaders = b3 && {b3};

    // this whole thing requires us to be in a Dial verb
    const task = this.currentTask;
    if (!task || ![TaskName.Dial, TaskName.Listen].includes(task.name)) {
      return this.logger.info('CallSession:_lccWhisper - invalid command since we are not in a dial or listen');
    }

    // allow user to provide a url object, a url string, an array of tasks, or a single task
    if (typeof whisper === 'string' || (typeof whisper === 'object' && whisper.url)) {
      // retrieve a url
      const json = await this.requestor(opts.call_hook, this.callInfo.toJSON(), httpHeaders);
      tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
    }
    else if (Array.isArray(whisper)) {
      // an inline array of tasks
      tasks = normalizeJambones(this.logger, whisper).map((tdata) => makeTask(this.logger, tdata));
    }
    else if (typeof whisper === 'object') {
      // a single task
      tasks = normalizeJambones(this.logger, [whisper]).map((tdata) => makeTask(this.logger, tdata));
    }
    else {
      this.logger.info({opts}, 'CallSession:_lccWhisper invalid options were provided');
      return;
    }
    this.logger.debug(`CallSession:_lccWhisper got ${tasks.length} tasks`);

    // only say or play allowed
    if (tasks.find((t) => ![TaskName.Say, TaskName.Play].includes(t.name))) {
      this.logger.info('CallSession:_lccWhisper invalid options where provided');
      return;
    }

    //multiple loops not allowed
    tasks.forEach((t) => t.loop = 1);

    // now do the whisper
    this.logger.debug(`CallSession:_lccWhisper executing ${tasks.length} tasks`);
    task.whisper(tasks, callSid).catch((err) => this.logger.error(err, 'CallSession:_lccWhisper'));
  }

  async _lccConfig(opts) {
    this.logger.debug({opts}, 'CallSession:_lccConfig');
    const t = normalizeJambones(this.logger, [
      {
        verb: 'config',
        ...opts
      }
    ])
      .map((tdata) => makeTask(this.logger, tdata));

    const task = t[0];

    const {span, ctx} = this.rootSpan.startChildSpan(`verb:${task.summary}`);
    span.setAttributes({'verb.summary': task.summary});
    task.span = span;
    task.ctx = ctx;
    try {
      await task.exec(this, {ep: this.ep});
    } catch (err) {
      this.logger.error(err, 'CallSession:_lccConfig');
    }
    task.span.end();
  }

  async _lccDub(opts, callSid) {
    this.logger.debug({opts}, `CallSession:_lccDub on call_sid ${callSid}`);
    const t = normalizeJambones(this.logger, [
      {
        verb: 'dub',
        ...opts
      }
    ])
      .map((tdata) => makeTask(this.logger, tdata));

    const task = t[0];
    const ep = this.currentTask?.name === TaskName.Dial && callSid === this.currentTask?.callSid ?
      this.currentTask.ep :
      this.ep;

    const {span, ctx} = this.rootSpan.startChildSpan(`verb:${task.summary}`);
    span.setAttributes({'verb.summary': task.summary});
    task.span = span;
    task.ctx = ctx;
    try {
      await task.exec(this, {ep});
    } catch (err) {
      this.logger.error(err, 'CallSession:_lccDub');
    }
    task.span.end();
  }


  async _lccBoostAudioSignal(opts, callSid) {
    const ep = this.currentTask?.name === TaskName.Dial && callSid === this.currentTask?.callSid ?
      this.currentTask.ep :
      this.ep;
    const db = parseDecibels(opts);
    this.logger.info(`_lccBoostAudioSignal: boosting audio signal by ${db} dB`);
    const args = [ep.uuid, 'setGain', db];
    const response = await ep.api('uuid_dub', args);
    this.logger.info({response}, '_lccBoostAudioSignal: response from freeswitch');
  }

  async _lccMediaPath(desiredPath) {
    const task = this.currentTask;
    if (!task || task.name !== TaskName.Dial) {
      return this.logger.info('CallSession:_lccMediaPath - invalid command since we are not in a dial verb');
    }
    task.updateMediaPath(desiredPath)
      .catch((err) => this.logger.error(err, 'CallSession:_lccMediaPath'));
  }

  _lccToolOutput(tool_call_id, opts, callSid) {
    // only valid if we are in an LLM verb
    const task = this.currentTask;
    if (!task || !task.name.startsWith('Llm')) {
      return this.logger.info('CallSession:_lccToolOutput - invalid command since we are not in an llm');
    }

    task.processToolOutput(tool_call_id, opts, callSid)
      .catch((err) => this.logger.error(err, 'CallSession:_lccToolOutput'));
  }


  _lccLlmUpdate(opts, callSid) {
    // only valid if we are in an LLM verb
    const task = this.currentTask;
    if (!task || !task.name.startsWith('Llm')) {
      return this.logger.info('CallSession:_lccLlmUpdate - invalid command since we are not in an llm');
    }

    task.processLlmUpdate(opts, callSid)
      .catch((err) => this.logger.error(err, 'CallSession:_lccLlmUpdate'));
  }


  /**
   * perform call hangup by jambonz
   */

  async hangup() {
    return this._callerHungup();
  }


  /**
   * perform live call control
   * @param {object} opts - update instructions
   * @param {string} callSid - identifies call to update
   */
  async updateCall(opts, callSid) {
    this.logger.debug(opts, 'CallSession:updateCall');

    if (opts.call_status) {
      return this._lccCallStatus(opts);
    }
    if (opts.call_hook || opts.child_call_hook) {
      return await this._lccCallHook(opts);
    }
    if (opts.listen_status) {
      await this._lccListenStatus(opts);
    }
    if (opts.transcribe_status) {
      await this._lccTranscribeStatus(opts);
    }
    else if (opts.mute_status) {
      await this._lccMuteStatus(opts.mute_status === 'mute', callSid);
    }
    else if (opts.conf_hold_status) {
      await this._lccConfHoldStatus(opts);
    }
    else if (opts.conf_mute_status) {
      await this._lccConfMuteStatus(opts);
    }
    else if (opts.sip_request) {
      const res = await this._lccSipRequest(opts, callSid);
      return {status: res.status, reason: res.reason};
    } else if (opts.dtmf) {
      await this._lccDtmf(opts, callSid);
    }
    else if (opts.record) {
      await this.notifyRecordOptions(opts.record);
    }
    else if (opts.tag) {
      return this._lccTag(opts);
    }
    else if (opts.conferenceParticipantAction) {
      return this._lccConferenceParticipantAction(opts.conferenceParticipantAction);
    }
    else if (opts.dub) {
      return this._lccDub(opts.dub, callSid);
    }
    else if (opts.boostAudioSignal) {
      return this._lccBoostAudioSignal(opts, callSid);
    }
    else if (opts.media_path) {
      return this._lccMediaPath(opts.media_path, callSid);
    }
    else if (opts.llm_tool_output) {
      return this._lccToolOutput(opts.tool_call_id, opts.llm_tool_output, callSid);
    }
    else if (opts.llm_update) {
      return this._lccLlmUpdate(opts.llm_update, callSid);
    }

    // whisper may be the only thing we are asked to do, or it may that
    // we are doing a whisper after having muted, paused recording etc..
    if (opts.whisper) {
      return this._lccWhisper(opts, callSid);
    }
  }

  /**
   * Replace the currently-executing application with a new application
   * NB: any tasks in the current stack that have not been executed are flushed
   */
  replaceApplication(tasks) {
    if (this.callGone) {
      this.logger.debug('CallSession:replaceApplication - ignoring because call is gone');
      return;
    }

    if (this.isSipRecCallSession) {
      const pruned = tasks.filter((t) => AllowedSipRecVerbs.includes(t.name));
      if (0 === pruned.length) {
        this.logger.info({tasks},
          'CallSession:replaceApplication - only config, transcribe and/or listen allowed on an incoming siprec call');
        return;
      }
      if (pruned.length < tasks.length) {
        this.logger.info(
          'CallSession:replaceApplication - removing verbs that are not allowed for incoming siprec call');
        tasks = pruned;
      }
    }
    else if (this.isConfirmCallSession) {
      const pruned = tasks.filter((t) => AllowedConfirmSessionVerbs.includes(t.name));
      if (0 === pruned.length) {
        this.logger.info({tasks},
          'CallSession:replaceApplication - filtering verbs allowed on an confirmSession call');
        return;
      }
      if (pruned.length < tasks.length) {
        this.logger.info(
          'CallSession:replaceApplication - removing verbs that are not allowed for confirmSession call');
        tasks = pruned;
      }
    }
    this.tasks = tasks;
    this.taskIdx = 0;
    this.stackIdx++;
    this.logger.info({tasks: listTaskNames(tasks)},
      `CallSession:replaceApplication reset with ${tasks.length} new tasks, stack depth is ${this.stackIdx}`);
    if (this.currentTask) {
      this.currentTask.kill(this, KillReason.Replaced);
      this.currentTask = null;
    }
    else if (this.wakeupResolver) {
      this.logger.debug('CallSession:replaceApplication - waking up');
      this.wakeupResolver({reason: 'new tasks'});
      this.wakeupResolver = null;
    }
  }

  kill(onBackgroundGatherBargein = false) {
    if (this.isConfirmCallSession) this.logger.debug('CallSession:kill (ConfirmSession)');
    else this.logger.info('CallSession:kill');
    this._endVerbHookSpan();
    if (this.currentTask) {
      this.currentTask.kill(this);
      this.currentTask = null;
    }
    if (onBackgroundGatherBargein) {
      /* search for a config with bargein disabled */
      while (this.tasks.length) {
        const t = this.tasks[0];
        if (t.name === TaskName.Config && t.bargeIn?.enable === false) {
          /* found it, clear to that point and remove the disable
            because we likely already received a partial transcription
            and we don't want to kill the background gather before we
            get the full transcription.
          */
          delete t.bargeIn.enable;
          this.logger.info('CallSession:kill - found bargein disabled in the stack, clearing to that point');
          break;
        }
        const rem = this.tasks.shift();
        this.logger.debug(`CallSession:kill - clearing task ${rem.summary}`);
      }
    }
    else this.tasks = [];
    this.taskIdx = 0;
  }

  _preCacheAudio(newTasks) {
    /**
     * only precache audio for the a queued say if we have one or more non-Config verbs
     * ahead of it in the queue.  This is because the Config verb returns immediately
     * and would not give us enough time to generate the audio.  The point of precaching
     * is to take advantage of getting the audio in advance of being needed, so we need
     * to be confident we have some time before the say verb is executed, and the Config
     * does not give us that confidence since it returns immediately.
     */
    const haveQueuedNonConfig = this.tasks.findIndex((t) => t.name !== TaskName.Config) !== -1;
    let tasks = haveQueuedNonConfig ? newTasks : [];
    if (!haveQueuedNonConfig) {
      const idxFirstNotConfig = newTasks.findIndex((t) => t.name !== TaskName.Config);
      if (-1 === idxFirstNotConfig) return;
      tasks = newTasks.slice(idxFirstNotConfig + 1);
    }

    for (const task of tasks) {
      if (task.name === TaskName.Config && task.hasSynthesizer) {
        /* if they change synthesizer settings don't try to precache */
        break;
      }
      if (task.name === TaskName.Say) {
        /* identify vendor language, voice, and label */
        const vendor = task.synthesizer.vendor && task.synthesizer.vendor !== 'default' ?
          task.synthesizer.vendor :
          this.speechSynthesisVendor;
        const language = task.synthesizer.language && task.synthesizer.language !== 'default' ?
          task.synthesizer.language :
          this.speechSynthesisLanguage ;
        const voice =  task.synthesizer.voice && task.synthesizer.voice !== 'default' ?
          task.synthesizer.voice :
          this.speechSynthesisVoice;
        const label = task.synthesizer.label && task.synthesizer.label !== 'default' ?
          task.synthesizer.label :
          this.speechSynthesisLabel;

        this.logger.info({vendor, language, voice, label},
          'CallSession:_preCacheAudio - precaching audio for future prompt');
        task._synthesizeWithSpecificVendor(this, this.ep, {vendor, language, voice, label, preCache: true})
          .catch((err) => this.logger.error(err, 'CallSession:_preCacheAudio - error precaching audio'));
      }
    }
  }

  /**
   * Append tasks to the current execution stack UNLESS there is a gather in the stack.
   * in that case, insert the tasks before the gather AND if the tasks include
   * a gather then delete/remove the gather from the existing stack
   * @param {*} t array of tasks
   */
  _injectTasks(newTasks) {
    const gatherPos = this.tasks.map((t) => t.name).indexOf(TaskName.Gather);
    const currentlyExecutingGather = this.currentTask?.name === TaskName.Gather;
    /*
    this.logger.debug({
      currentTaskList: listTaskNames(this.tasks),
      newContent: listTaskNames(newTasks),
      currentlyExecutingGather,
      gatherPos
    }, 'CallSession:_injectTasks - starting');
    */
    const killGather = () => {
      this.logger.debug('CallSession:_injectTasks - killing current gather because we have new content');
      this.currentTask.kill(this);
    };

    if (-1 === gatherPos) {
      /* no gather in the stack  simply append tasks */
      this.tasks.push(...newTasks);
      /*
      this.logger.debug({
        updatedTaskList: listTaskNames(this.tasks)
      }, 'CallSession:_injectTasks - completed (simple append)');
      */
      /* we do need to kill the current gather if we are executing one */
      if (currentlyExecutingGather) killGather();
      return;
    }

    if (currentlyExecutingGather) killGather();
    const newTasksHasGather = newTasks.find((t) => t.name === TaskName.Gather);
    this.tasks.splice(gatherPos, newTasksHasGather ? 1 : 0, ...newTasks);

    this.logger.debug({
      updatedTaskList: listTaskNames(this.tasks)
    }, 'CallSession:_injectTasks - completed');
  }

  async _onSessionReconnectError(err) {
    const {writeAlerts, AlertType} = this.srf.locals;
    const sid = this.accountInfo.account.account_sid;
    this.logger.info({err}, `_onSessionReconnectError for account ${sid}`);
    try {
      await writeAlerts({
        alert_type: AlertType.WEBHOOK_CONNECTION_FAILURE,
        account_sid: this.accountSid,
        detail: `Session:reconnect error ${err}`,
        url: this.application.call_hook.url,
      });
    } catch (error) {
      this.logger.error({error}, 'Error writing WEBHOOK_CONNECTION_FAILURE alert');
    }
    this._jambonzHangup();
  }

  async _onCommand({msgid, command, call_sid, queueCommand, tool_call_id, data}) {
    this.logger.info({msgid, command, queueCommand, data}, 'CallSession:_onCommand - received command');
    let resolution;
    switch (command) {
      case 'redirect':
        if (Array.isArray(data)) {
          this._endVerbHookSpan();
          const t = normalizeJambones(this.logger, data)
            .map((tdata) => makeTask(this.logger, tdata));
          if (!queueCommand) {
            this.logger.info({tasks: listTaskNames(t)}, 'CallSession:_onCommand new task list');
            this.replaceApplication(t);
          }
          else if (JAMBONES_INJECT_CONTENT) {
            if (JAMBONES_EAGERLY_PRE_CACHE_AUDIO) this._preCacheAudio(t);
            this._injectTasks(t);
            this.logger.info({tasks: listTaskNames(this.tasks)}, 'CallSession:_onCommand - updated task list');
          }
          else {
            if (JAMBONES_EAGERLY_PRE_CACHE_AUDIO) this._preCacheAudio(t);
            this.tasks.push(...t);
            this.logger.info({tasks: listTaskNames(this.tasks)}, 'CallSession:_onCommand - updated task list');
          }
          resolution = {reason: 'received command, new tasks', queue: queueCommand, command};
          resolution.command = listTaskNames(t);

          // clear all delay action hook timeout if there is
          await this.clearOrRestoreActionHookDelayProcessor();
        }
        else this._lccCallHook(data);
        break;

      case 'call:status':
        this._lccCallStatus(data);
        break;

      case 'config':
        this._lccConfig(data, call_sid);
        break;

      case 'dial':
        this._lccCallDial(data);
        break;

      case 'dub':
        this._lccDub(data, call_sid);
        break;

      case 'record':
        this.notifyRecordOptions(data);
        break;

      case 'mute:status':
        this._lccMuteStatus(data, call_sid);
        break;

      case 'conf:mute-status':
        this._lccConfMuteStatus(data);
        break;

      case 'conf:hold-status':
        this._lccConfHoldStatus(data);
        break;

      case 'conf:participant-action':
        this._lccConferenceParticipantAction(data);
        break;

      case 'listen:status':
        this._lccListenStatus(data);
        break;

      case 'transcribe:status':
        this._lccTranscribeStatus(data);
        break;

      case 'whisper':
        this._lccWhisper(data, call_sid);
        break;

      case 'sip:request':
        this._lccSipRequest(data, call_sid)
          .catch((err) => {
            this.logger.info({err, data}, `CallSession:_onCommand - error sending ${data.method}`);
          });
        break;

      case 'dtmf':
        this._lccDtmf(data, call_sid)
          .catch((err) => {
            this.logger.info({err, data}, `CallSession:_onCommand - error sending RFC 2833 DTMF ${data}`);
          });
        break;

      case 'boostAudioSignal':
        this._lccBoostAudioSignal(data, call_sid)
          .catch((err) => {
            this.logger.info({err, data}, 'CallSession:_onCommand - error boosting audio signal');
          });
        break;

      case 'media:path':
        this._lccMediaPath(data, call_sid)
          .catch((err) => {
            this.logger.info({err, data}, 'CallSession:_onCommand - error setting media path');
          });
        break;

      case 'llm:tool-output':
        this._lccToolOutput(tool_call_id, data, call_sid);
        break;

      case 'llm:update':
        this._lccLlmUpdate(data, call_sid);
        break;

      default:
        this.logger.info(`CallSession:_onCommand - invalid command ${command}`);
    }
    if (this.wakeupResolver && resolution) {
      //this.logger.debug({resolution}, 'CallSession:_onCommand - got commands, waking up..');
      this.wakeupResolver(resolution);
      this.wakeupResolver = null;
    }
    /*
    else {
      const {queue, command} = resolution;
      const {span} = this.rootSpan.startChildSpan(`recv cmd: ${command}`);
      span.setAttributes({
        'async.request.queue': queue,
        'async.request.command': command
      });
      span.end();
    }
    */
  }

  _onWsConnectionDropped() {
    const {stats} = this.srf.locals;
    stats.increment('app.hook.remote_close');
  }

  _evaluatePreconditions(task) {
    switch (task.preconditions) {
      case TaskPreconditions.None:
        return;
      case TaskPreconditions.Endpoint:
        return this._evalEndpointPrecondition(task);
      case TaskPreconditions.StableCall:
        return this._evalStableCallPrecondition(task);
      case TaskPreconditions.UnansweredCall:
        return this._evalUnansweredCallPrecondition(task);
      default:
        assert(0, `invalid/unknown or missing precondition type ${task.preconditions} for task ${task.name}`);
    }
  }

  /**
   * Configure call state so as to make a media endpoint available
   * @param {Task} task - task to be executed
   */
  async _evalEndpointPrecondition(task) {
    if (this.callGone) new Error(`${BADPRECONDITIONS}: call gone`);

    if (this.ep) {
      const resources = {ep: this.ep};
      if (task.earlyMedia === true || this.dlg) {
        return {
          ...resources,
          ...(this.isSipRecCallSession && {ep2: this.ep2})
        };
      }

      this._enableInbandDtmfIfRequired(this.ep);

      // we are going from an early media connection to answer
      if (this.direction === CallDirection.Inbound) {
        // only do this for inbound call.
        await this.propagateAnswer();
      }
      return {
        ...resources,
        ...(this.isSipRecCallSession && {ep2: this.ep2})
      };
    }

    // need to allocate an endpoint
    try {
      if (!this.ms) this.ms = this.getMS();
      const ep = await this.ms.createEndpoint({
        headers: {
          'X-Jambones-Call-ID': this.callId,
        },
        remoteSdp: this.req.body
      });
      //ep.cs = this;
      this.ep = ep;
      this.logger.info(`allocated endpoint ${ep.uuid}`);

      this._configMsEndpoint();

      this.ep.on('destroy', () => {
        this.logger.debug(`endpoint was destroyed!! ${this.ep.uuid}`);
      });

      if (this.direction === CallDirection.Inbound) {
        if (task.earlyMedia && !this.req.finalResponseSent) {
          this.res.send(183, {body: ep.local.sdp});
          return {ep};
        }
        this.logger.debug('propogating answer');
        await this.propagateAnswer();
      }
      else {
        // outbound call TODO
      }

      return {ep};
    } catch (err) {
      if (err === CALLER_CANCELLED_ERR_MSG) {
        this.logger.error(err, 'caller canceled quickly before we could respond, ending call');
        this.callInfo.callTerminationBy = 'caller';
        this._notifyCallStatusChange({
          callStatus: CallStatus.NoAnswer,
          sipStatus: 487,
          sipReason: 'Request Terminated'
        });
        this._callReleased();
      }
      else {
        this.logger.error(err, `Error attempting to allocate endpoint for for task ${task.name}`);
        throw new Error(`${BADPRECONDITIONS}: unable to allocate endpoint`);
      }
    }
  }

  /**
   * Configure call state so as to make a sip dialog available
   * @param {Task} task - task to be executed
   */
  _evalStableCallPrecondition(task) {
    if (this.callGone) throw new Error(`${BADPRECONDITIONS}: call gone`);
    if (!this.dlg) throw new Error(`${BADPRECONDITIONS}: call was not answered`);
    return {dlg: this.dlg};
  }

  /**
   * Throws an error if call has already been answered
   * @param {Task} task - task to be executed
   */
  _evalUnansweredCallPrecondition(task, callSid) {
    if (!this.req) throw new Error('invalid precondition unanswered_call for outbound call');
    if (this.callGone) new Error(`${BADPRECONDITIONS}: call gone`);
    if (this.res.finalResponseSent) {
      throw new Error(`${BADPRECONDITIONS}: final sip status already sent`);
    }
    return {req: this.req, res: this.res};
  }

  /**
   * Discard the current endpoint and allocate a new one, connecting the dialog to it.
   * This is used, for instance, from the Conference verb when a caller has been
   * kicked out of conference when a moderator leaves -- the endpoint is destroyed
   * as well, but the app may want to continue on with other actions
   */
  async replaceEndpoint() {
    if (!this.dlg) {
      this.logger.error('CallSession:replaceEndpoint cannot be called without stable dlg');
      return;
    }
    // When this call kicked out from conference, session need to replace endpoint
    // but this.ms might be undefined/null at this case.
    this.ms = this.ms || this.getMS();
    // Destroy previous ep if it's still running.
    if (this.ep?.connected) this.ep.destroy();

    this.ep = await this.ms.createEndpoint({remoteSdp: this.dlg.remote.sdp});
    this._configMsEndpoint();

    await this.dlg.modify(this.ep.local.sdp);
    this.logger.debug('CallSession:replaceEndpoint completed');
    return this.ep;
  }

  /**
   * Hang up the call and free the media endpoint
   */
  _clearResources() {
    for (const resource of [this.dlg, this.ep, this.ep2]) {
      if (resource && resource.connected) resource.destroy();
    }
    this.dlg = null;
    this.ep = null;

    // remove any temporary tts files that were created (audio is still cached in redis)
    for (const path of this.tmpFiles) {
      fs.unlink(path, (err) => {
        if (err) {
          return this.logger.error(err, `CallSession:_clearResources Error deleting tmp file ${path}`);
        }
        this.logger.debug(`CallSession:_clearResources successfully deleted ${path}`);
      });
    }
    this.tmpFiles.clear();
    this.requestor && this.requestor.close();
    this.notifier && this.notifier.close();

    this.rootSpan && this.rootSpan.end();
    // close all background tasks
    this.backgroundTaskManager.stopAll();
    this.clearOrRestoreActionHookDelayProcessor().catch((err) => {});
  }

  /**
   * called when the caller has hung up.  Provided for subclasses to override
   * in order to apply logic at this point if needed.
   * return true if success fallback, return false if not
   */
  _callerHungup() {
    assert(false, 'subclass responsibility to override this method');
  }

  /**
   * called when the jambonz has hung up.  Provided for subclasses to override
   * in order to apply logic at this point if needed.
   */
  _jambonzHangup() {
    assert(false, 'subclass responsibility to override this method');
  }

  /**
   * get a media server to use for this call
   */
  getMS() {
    if (!this.ms) {
      this.ms = this.srf.locals.getFreeswitch();
      if (!this.ms) {
        this._mediaServerFailure = true;
        throw new Error('no available freeswitch');
      }
    }
    return this.ms;
  }

  /**
   * Answer the call, if it has not already been answered.
   *
   * NB: This should be the one and only place we generate 200 OK to incoming INVITEs
   */
  async propagateAnswer() {
    if (!this.dlg) {
      assert(this.ep);
      this.dlg = await this.srf.createUAS(this.req, this.res, {
        headers: {
          'X-Trace-ID': this.req.locals.traceId,
          'X-Call-Sid': this.req.locals.callSid,
          ...(this.applicationSid && {'X-Application-Sid': this.applicationSid})
        },
        localSdp: this.ep.local.sdp
      });
      this.logger.debug('answered call');
      this.dlg.on('destroy', this._callerHungup.bind(this));
      this.wrapDialog(this.dlg);
      this.dlg.callSid = this.callSid;
      this.emit('callStatusChange', {sipStatus: 200, sipReason: 'OK', callStatus: CallStatus.InProgress});

      if (this.recordOptions && this.recordState === RecordState.RecordingOff) {
        this.startRecording();
      }
      this.dlg.on('modify', this._onReinvite.bind(this));
      this.dlg.on('refer', this._onRefer.bind(this));
      if (this.sipRequestWithinDialogHook) {
        this.dlg.on('info', this._onRequestWithinDialog.bind(this));
        this.dlg.on('message', this._onRequestWithinDialog.bind(this));
      }
      this.logger.debug(`CallSession:propagateAnswer - answered callSid ${this.callSid}`);
    }
    else {
      this.logger.debug('CallSession:propagateAnswer - call already answered - re-anchor media with a reinvite');
      await this.dlg.modify(this.ep.local.sdp);
    }
  }

  async _onRequestWithinDialog(req, res) {
    if (!this.sipRequestWithinDialogHook) {
      return;
    }
    const sip_method = req.method;
    if (sip_method === 'INFO') {
      res.send(200);
    } else if (sip_method === 'MESSAGE') {
      res.send(202);
    } else {
      this.logger.info(`CallSession:_onRequestWithinDialog unsported method: ${req.method}`);
      res.send(501);
      return;
    }
    const params = {sip_method, sip_body: req.body, sip_headers: req.headers};
    this.currentTask.performHook(this, this.sipRequestWithinDialogHook, params);
  }

  async _onReinvite(req, res) {
    try {
      if (this.ep) {
        if (this.isSipRecCallSession) {
          this.logger.info('handling reINVITE for siprec call');
          res.send(200, {body: this.ep.local.sdp});
        }
        else {
          if (this.currentTask.name === TaskName.Dial && this.currentTask.isOnHoldEnabled) {
            this.logger.info('onholdMusic reINVITE after media has been released');
            await this.currentTask.handleReinviteAfterMediaReleased(req, res);
          } else {
            const newSdp = await this.ep.modify(req.body);
            res.send(200, {body: newSdp});
            this.logger.info({offer: req.body, answer: newSdp}, 'handling reINVITE');
          }
        }
      }
      else if (this.currentTask && this.currentTask.name === TaskName.Dial) {
        this.logger.info('handling reINVITE after media has been released');
        await this.currentTask.handleReinviteAfterMediaReleased(req, res);
      }
      else {
        this.logger.info('got reINVITE but no endpoint and media has not been released');
        res.send(488);
      }
    } catch (err) {
      this.logger.error(err, 'Error handling reinvite');
    }
  }

  /**
   * Handle incoming REFER
   * @param {*} req
   * @param {*} res
   */
  _onRefer(req, res) {
    const task = this.currentTask;
    const sd = task.sd;
    if (task && TaskName.Dial === task.name && sd && task.referHook) {
      task.handleRefer(this, req, res);
    }
    else {
      this._handleRefer(req, res);
    }
  }

  async _handleRefer(req, res) {
    if (this._referHook) {
      try {
        const to = parseUri(req.getParsedHeader('Refer-To').uri);
        const by = parseUri(req.getParsedHeader('Referred-By').uri);
        const customHeaders = Object.keys(req.headers)
          .filter((h) => h.toLowerCase().startsWith('x-'))
          .reduce((acc, h) => {
            acc[h] = req.get(h);
            return acc;
          }, {});
        const b3 = this.b3;
        const httpHeaders = b3 && {b3};
        const json = await this.requestor.request('verb:hook', this._referHook, {
          ...(this.callInfo.toJSON()),
          refer_details: {
            sip_refer_to: req.get('Refer-To'),
            sip_referred_by: req.get('Referred-By'),
            sip_user_agent: req.get('User-Agent'),
            refer_to_user: to.scheme === 'tel' ? to.number : to.user,
            referred_by_user: by.scheme === 'tel' ? by.number : by.user,
            referring_call_sid: this.callSid,
            referred_call_sid: null,
            ...customHeaders
          }
        }, httpHeaders);

        if (json && Array.isArray(json)) {
          const tasks = normalizeJambones(this.logger, json).map((tdata) => makeTask(this.logger, tdata));
          if (tasks && tasks.length > 0) {
            this.logger.info('CallSession:handleRefer received REFER, get new tasks');
            this.replaceApplication(tasks);
            if (this.wakeupResolver) {
              this.wakeupResolver({reason: 'CallSession: referHook new taks'});
              this.wakeupResolver = null;
            }
          }
        }
        res.send(202);
        this.logger.info('CallSession:handleRefer - sent 202 Accepted');
      } catch (err) {
        this.logger.error({err}, 'CallSession:handleRefer - error while asking referHook');
        res.send(err.statusCode || 501);
      }
    } else {
      res.send(501);
    }
  }

  /**
   * create and endpoint if we don't have one; otherwise simply return
   * the current media server and endpoint that are associated with this call
   */
  async createOrRetrieveEpAndMs() {
    if (this.ms && this.ep) return {ms: this.ms, ep: this.ep};

    // get a media server
    if (!this.ms) {
      const ms = this.srf.locals.getFreeswitch();
      if (!ms) throw new Error('no available freeswitch');
      this.ms = ms;
    }
    if (!this.ep) {
      this.ep = await this.ms.createEndpoint({remoteSdp: this.req.body});
      this._configMsEndpoint();
    }
    return {ms: this.ms, ep: this.ep};
  }

  /**
   * If account was queue event webhook, send notification
   * @param {*} obj - data to notify
   */
  async performQueueWebhook(obj) {
    if (typeof this.queueEventHookRequestor === 'undefined') {
      const pp = this._pool.promise();
      try {
        this.logger.info({accountSid: this.accountSid}, 'performQueueWebhook: looking up account');
        const [r] = await pp.query(sqlRetrieveQueueEventHook, [this.accountSid]);
        if (0 === r.length) {
          this.logger.info({accountSid: this.accountSid}, 'performQueueWebhook: no webhook provisioned');
          this.queueEventHookRequestor = null;
        }
        else {
          this.logger.info({accountSid: this.accountSid, webhook: r[0]}, 'performQueueWebhook: webhook found');
          this.queueEventHookRequestor = new HttpRequestor(this.logger, this.accountSid,
            r[0], this.webhook_secret);
          this.queueEventHook = r[0];
        }
      } catch (err) {
        this.logger.error({err, accountSid: this.accountSid}, 'Error retrieving event hook');
        this.queueEventHookRequestor = null;
      }
    }
    if (null === this.queueEventHookRequestor) return;

    /* send webhook */
    const params =  {...obj, ...this.callInfo.toJSON()};
    this.logger.info({accountSid: this.accountSid, params}, 'performQueueWebhook: sending webhook');
    this.queueEventHookRequestor.request('queue:status', this.queueEventHook, params)
      .catch((err) => {
        this.logger.info({err, accountSid: this.accountSid, obj}, 'Error sending queue notification event');
      });
  }

  /**
   * A conference that the current task is waiting on has just started
   * @param {*} opts
   */
  notifyConferenceEvent(opts) {
    if (this.currentTask && typeof this.currentTask.notifyStartConference === 'function') {
      this.currentTask.notifyStartConference(this, opts);
    }
  }

  /**
   * Notify a session in an Enqueue task of an event
   * @param {*} opts
   */
  notifyEnqueueEvent(opts) {
    if (this.currentTask && typeof this.currentTask.notifyQueueEvent === 'function') {
      this.currentTask.notifyQueueEvent(this, opts);
    }
  }

  /**
   * Notify a session in a Dequeue task of an event
   * @param {*} opts
   */
  notifyDequeueEvent(opts) {
    if (this.currentTask && typeof this.currentTask.notifyQueueEvent === 'function') {
      this.currentTask.notifyQueueEvent(this, opts);
    }
  }

  /**
   * Transfer the call to another feature server
   * @param {uri} sip uri to refer the call to
   */
  async referCall(referTo) {
    assert (this.hasStableDialog);

    const res = await this.dlg.request({
      method: 'REFER',
      headers: {
        'Refer-To': referTo,
        'Referred-By': `sip:${this.srf.locals.localSipAddress}`,
        'X-Retain-Call-Sid': this.callSid,
        'X-Account-Sid': this.accountSid
      }
    });
    if ([200, 202].includes(res.status)) {
      this.tasks = [];
      this.taskIdx = 0;
      this.callMoved = true;
      return true;
    }
    return false;
  }

  getRemainingTaskData() {
    const tasks = [...this.tasks];
    tasks.unshift(this.currentTask);
    const remainingTasks = [];
    for (const task of tasks) {
      const o = {};
      o[task.name] = task.toJSON();
      remainingTasks.push(o);
    }
    return remainingTasks;
  }

  /**
   * Call this whenever we answer the A leg, creating a dialog
   * It wraps the 'destroy' method such that if we hang up the A leg
   * (e.g. via 'hangup' verb) we emit a callStatusChange event
   * @param {SipDialog} dlg
   */
  wrapDialog(dlg) {
    dlg.connectTime = moment();
    const origDestroy = dlg.destroy.bind(dlg);
    dlg.destroy = (opts) => {
      if (dlg.connected) {
        dlg.connected = false;
        dlg.destroy = origDestroy;
        const duration = moment().diff(this.dlg.connectTime, 'seconds');
        this.callInfo.callTerminationBy = 'jambonz';
        this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
        this.logger.debug('CallSession: call terminated by jambonz');
        this.rootSpan.setAttributes({'call.termination': 'hangup by jambonz'});
        origDestroy(opts).catch((err) => this.logger.info({err}, 'CallSession - error destroying dialog'));
        if (this.wakeupResolver) {
          this.wakeupResolver({reason: 'session ended'});
          this.wakeupResolver = null;
        }
      }
    };
  }

  async releaseMediaToSBC(remoteSdp, releaseMediaEntirely) {
    assert(this.dlg && this.dlg.connected && this.ep && typeof remoteSdp === 'string');
    await this.dlg.modify(remoteSdp, {
      headers: {
        'X-Reason': releaseMediaEntirely ? 'release-media-entirely' : 'release-media'
      }
    });
    try {
      await this.ep.destroy();
    } catch (err) {
      this.logger.error({err}, 'CallSession:releaseMediaToSBC: Error destroying endpoint');
    }
    this.ep = null;
  }

  async reAnchorMedia(currentMediaRoute = MediaPath.PartialMedia) {
    assert(this.dlg && this.dlg.connected && !this.ep);

    this.ep = await this.ms.createEndpoint({remoteSdp: this.dlg.remote.sdp});
    this._configMsEndpoint();
    await this.dlg.modify(this.ep.local.sdp, {
      headers: {
        'X-Reason': 'anchor-media'
      }
    });

    if (currentMediaRoute === MediaPath.NoMedia) {
      await this.ep.modify(this.dlg.remote.sdp);
    }
  }

  async handleReinviteAfterMediaReleased(req, res) {
    assert(this.dlg && this.dlg.connected && !this.ep);
    const sdp = await this.dlg.modify(req.body);
    this.logger.info({sdp}, 'CallSession:handleReinviteAfterMediaReleased - reinvite to A leg returned sdp');
    res.send(200, {body: sdp});
  }

  /**
   * Called any time call status changes.  This method both invokes the
   * call_status_hook callback as well as updates the realtime database
   * with latest call status
   * @param {object} opts
   * @param {string} callStatus - current call status
   * @param {number} sipStatus - current sip status
   * @param {number} [duration] - duration of a completed call, in seconds
   */
  async _notifyCallStatusChange({callStatus, sipStatus, sipReason, duration}) {
    if (this.callMoved) return;

    // manage record all call.
    if (callStatus === CallStatus.InProgress) {
      if (this.accountInfo.account.record_all_calls ||
        this.application.record_all_calls) {
        this.backgroundTaskManager.newTask('record');
      }
    } else if (callStatus == CallStatus.Completed) {
      this.backgroundTaskManager.stop('record');
    }

    /* race condition: we hang up at the same time as the caller */
    if (callStatus === CallStatus.Completed) {
      if (this.notifiedComplete) return;
      this.notifiedComplete = true;
    }

    assert((typeof duration === 'number' && callStatus === CallStatus.Completed) ||
      (!duration && callStatus !== CallStatus.Completed),
    'duration MUST be supplied when call completed AND ONLY when call completed');

    this.callInfo.updateCallStatus(callStatus, sipStatus, sipReason);
    if (typeof duration === 'number') this.callInfo.duration = duration;
    this.executeStatusCallback(callStatus, sipStatus);

    // update calls db
    //this.logger.debug(`updating redis with ${JSON.stringify(this.callInfo)}`);
    this.updateCallStatus(Object.assign({}, this.callInfo.toJSON()), this.serviceUrl)
      .catch((err) => this.logger.error(err, 'redis error'));
  }

  async executeStatusCallback(callStatus, sipStatus) {
    const {span} = this.rootSpan.startChildSpan(`call-status:${this.callInfo.callStatus}`);
    span.setAttributes(this.callInfo.toJSON());
    try {
      const b3 = this.b3;
      const httpHeaders = b3 && {b3};
      await this.notifier.request('call:status', this.call_status_hook, this.callInfo.toJSON(), httpHeaders);
      span.end();
    } catch (err) {
      span.end();
      this.logger.info(err, `CallSession:_notifyCallStatusChange error sending ${callStatus} ${sipStatus}`);
    }
  }

  _configMsEndpoint() {
    this._enableInbandDtmfIfRequired(this.ep);
    const opts = {
      ...(this.onHoldMusic && {holdMusic: `shout://${this.onHoldMusic.replace(/^https?:\/\//, '')}`}),
      ...(JAMBONES_USE_FREESWITCH_TIMER_FD && {timer_name: 'timerfd'})
    };
    if (Object.keys(opts).length > 0) {
      this.ep.set(opts);
    }
  }

  async _enableInbandDtmfIfRequired(ep) {
    if (ep.inbandDtmfEnabled) return;
    // only enable inband dtmf detection if voip carrier dtmf_type === tones
    if (this.inbandDtmfEnabled) {
      // https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod-dptools/6587132/#0-about
      try {
        ep.execute('start_dtmf');
        ep.inbandDtmfEnabled = true;
      } catch (err) {
        this.logger.info(err, 'CallSession:_enableInbandDtmf - error enable inband DTMF');
      }
    }
  }

  /**
   * notifyTaskError - only used when websocket connection is used instead of webhooks
   */

  _notifyTaskError(obj) {
    if (this.requestor instanceof WsRequestor) {
      this.requestor.request('jambonz:error', '/error', obj)
        .catch((err) => this.logger.debug({err}, 'CallSession:_notifyTaskError - Error sending'));
    }
  }

  _notifyTaskStatus(task, evt) {
    if (this.notifyEvents && this.requestor instanceof WsRequestor) {
      const obj = {...evt, id: task.id, name: task.name};
      this.requestor.request('verb:status', '/status', obj)
        .catch((err) => this.logger.debug({err}, 'CallSession:_notifyTaskStatus - Error sending'));
    }
  }

  _awaitCommandsOrHangup() {
    assert(!this.wakeupResolver);
    return new Promise((resolve, reject) => {
      this.logger.info('_awaitCommandsOrHangup - waiting...');
      this.wakeupResolver = resolve;

      if (this._actionHookDelayProcessor) {
        this._actionHookDelayProcessor.start();
      }

      /**
       * TODO: filler noise can be handled as an ActionHookDelayProcessor -
       * it's just one specific scenario for action hook delay -
       * remove the code below and simply implement filler noise as an action hook delay
       */

      /* start filler noise if configured while we wait for new commands */
      if (this.fillerNoise?.url && this.ep?.connected && !this.ep2) {
        this.logger.debug('CallSession:_awaitCommandsOrHangup - playing filler noise');
        this._isPlayingFillerNoise = true;
        this.ep.play(this.fillerNoise.url);
        this.ep.once('playback-start', (evt) => {
          if (evt.file === this.fillerNoise.url && !this._isPlayingFillerNoise) {
            this.logger.info('CallSession:_awaitCommandsOrHangup - filler noise started');
            this.ep.api('uuid_break', this.ep.uuid)
              .catch((err) => this.logger.info(err, 'Error killing filler noise'));
          }
        });
      }
    });
  }

  _clearTasks(backgroundGather, evt) {
    if (this.requestor instanceof WsRequestor && !backgroundGather.cleared) {
      this.logger.info({evt}, 'CallSession:_clearTasks on event from background gather');
      try {
        backgroundGather.cleared = true;
        this.kill(true);
      } catch (err) {}
    }
  }

  /**
   * startBackgroundTask - Start background task
   */

  async startBackgroundTask(type, opts) {
    await this.backgroundTaskManager.newTask(type, opts);
  }

  stopBackgroundTask(type) {
    this.backgroundTaskManager.stop(type);
  }

  _endVerbHookSpan() {
    if (this.verbHookSpan) {
      this.verbHookSpan.end();
      this.verbHookSpan = null;
    }
  }
}

module.exports = CallSession;
