const Emitter = require('events');
const fs = require('fs');
const {
  CallDirection,
  TaskPreconditions,
  CallStatus,
  TaskName,
  KillReason,
  RecordState,
  AllowedSipRecVerbs
} = require('../utils/constants');
const moment = require('moment');
const assert = require('assert');
const sessionTracker = require('./session-tracker');
const makeTask = require('../tasks/make_task');
const { normalizeJambones } = require('@jambonz/verb-specifications');
const listTaskNames = require('../utils/summarize-tasks');
const HttpRequestor = require('../utils/http-requestor');
const WsRequestor = require('../utils/ws-requestor');
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
      this.requestor.on('connection-dropped', this._onWsConnectionDropped.bind(this));
      this.requestor.on('handover', handover.bind(this));
    };

    this.requestor.on('command', this._onCommand.bind(this));
    this.requestor.on('connection-dropped', this._onWsConnectionDropped.bind(this));
    this.requestor.on('handover', handover.bind(this));
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
   * default vendor to use for speech synthesis if not provided in the app
   */
  get speechSynthesisVendor() {
    return this.application.speech_synthesis_vendor;
  }
  set speechSynthesisVendor(vendor) {
    this.application.speech_synthesis_vendor = vendor;
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
  /**
   * default language to use for speech synthesis if not provided in the app
   */
  get speechSynthesisLanguage() {
    return this.application.speech_synthesis_language;
  }
  set speechSynthesisLanguage(language) {
    this.application.speech_synthesis_language = language;
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
  /**
 * default language to use for speech recognition if not provided in the app
 */
  get speechRecognizerLanguage() {
    return this.application.speech_recognizer_language;
  }
  set speechRecognizerLanguage(language) {
    this.application.speech_recognizer_language = language;
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
    return this.backgroundGatherTask;
  }

  get isListenEnabled() {
    return this.backgroundListenTask;
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

  hasGlobalSttPunctuation() {
    return this._globalSttPunctuation !== undefined;
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
        }
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
          'X-Reason': 'stopCallRecording',
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
        }
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
        }
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

  async startBackgroundListen(opts) {
    if (this.isListenEnabled) {
      this.logger.info('CallSession:startBackgroundListen - listen is already enabled, ignoring request');
      return;
    }
    try {
      this.logger.debug({opts}, 'CallSession:startBackgroundListen');
      const t = normalizeJambones(this.logger, [opts]);
      this.backgroundListenTask = makeTask(this.logger, t[0]);
      const resources = await this._evaluatePreconditions(this.backgroundListenTask);
      const {span, ctx} = this.rootSpan.startChildSpan(`background-gather:${this.backgroundListenTask.summary}`);
      this.backgroundListenTask.span = span;
      this.backgroundListenTask.ctx = ctx;
      this.backgroundListenTask.exec(this, resources)
        .then(() => {
          this.logger.info('CallSession:startBackgroundListen: listen completed');
          this.backgroundListenTask && this.backgroundListenTask.removeAllListeners();
          this.backgroundListenTask && this.backgroundListenTask.span.end();
          this.backgroundListenTask = null;
          return;
        })
        .catch((err) => {
          this.logger.info({err}, 'CallSession:startBackgroundListen: listen threw error');
          this.backgroundListenTask && this.backgroundListenTask.removeAllListeners();
          this.backgroundListenTask && this.backgroundListenTask.span.end();
          this.backgroundListenTask = null;
        });
    } catch (err) {
      this.logger.info({err, opts}, 'CallSession:startBackgroundListen - Error creating listen task');
    }
  }

  async stopBackgroundListen() {
    try {
      if (this.backgroundListenTask) {
        this.backgroundListenTask.removeAllListeners();
        this.backgroundListenTask.kill().catch(() => {});
      }
    } catch (err) {
      this.logger.info({err}, 'CallSession:stopBackgroundListen - Error stopping listen task');
    }
    this.backgroundListenTask = null;
  }

  async enableBotMode(gather, autoEnable) {
    try {
      if (this.backgroundGatherTask) {
        this.logger.info('CallSession:enableBotMode - bot mode currently enabled, ignoring request to start again');
        return;
      }
      const t = normalizeJambones(this.logger, [gather]);
      this.backgroundGatherTask = makeTask(this.logger, t[0]);
      this._bargeInEnabled = true;
      this.backgroundGatherTask
        .once('dtmf', this._clearTasks.bind(this, this.backgroundGatherTask))
        .once('vad', this._clearTasks.bind(this, this.backgroundGatherTask))
        .once('transcription', this._clearTasks.bind(this, this.backgroundGatherTask))
        .once('timeout', this._clearTasks.bind(this, this.backgroundGatherTask));
      this.logger.info({gather}, 'CallSession:enableBotMode - starting background gather');
      const resources = await this._evaluatePreconditions(this.backgroundGatherTask);
      const {span, ctx} = this.rootSpan.startChildSpan(`background-gather:${this.backgroundGatherTask.summary}`);
      this.backgroundGatherTask.span = span;
      this.backgroundGatherTask.ctx = ctx;
      this.backgroundGatherTask.exec(this, resources)
        .then(() => {
          this.logger.info('CallSession:enableBotMode: gather completed');
          this.backgroundGatherTask && this.backgroundGatherTask.removeAllListeners();
          this.backgroundGatherTask && this.backgroundGatherTask.span.end();
          this.backgroundGatherTask = null;
          if (autoEnable && !this.callGone && !this._stopping && this._bargeInEnabled) {
            this.logger.info('CallSession:enableBotMode: restarting background gather');
            setImmediate(() => this.enableBotMode(gather, true));
          }
          return;
        })
        .catch((err) => {
          this.logger.info({err}, 'CallSession:enableBotMode: gather threw error');
          this.backgroundGatherTask && this.backgroundGatherTask.removeAllListeners();
          this.backgroundGatherTask && this.backgroundGatherTask.span.end();
          this.backgroundGatherTask = null;
        });
    } catch (err) {
      this.logger.info({err, gather}, 'CallSession:enableBotMode - Error creating gather task');
    }
  }
  disableBotMode() {
    this._bargeInEnabled = false;
    if (this.backgroundGatherTask) {
      try {
        this.backgroundGatherTask.removeAllListeners();
        this.backgroundGatherTask.kill().catch((err) => {});
      } catch (err) {}
      this.backgroundGatherTask = null;
    }
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
  getSpeechCredentials(vendor, type) {
    const {writeAlerts, AlertType} = this.srf.locals;
    if (this.accountInfo.speech && this.accountInfo.speech.length > 0) {
      const credential = this.accountInfo.speech.find((s) => s.vendor === vendor);
      if (credential && (
        (type === 'tts' && credential.use_for_tts) ||
        (type === 'stt' && credential.use_for_stt)
      )) {
        if ('google' === vendor) {
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
              vendor
            }).catch((err) => this.logger.error({err}, 'Error writing tts alert'));
          }
        }
        else if (['aws', 'polly'].includes(vendor)) {
          return {
            speech_credential_sid: credential.speech_credential_sid,
            accessKeyId: credential.access_key_id,
            secretAccessKey: credential.secret_access_key,
            region: credential.aws_region || process.env.AWS_REGION
          };
        }
        else if ('microsoft' === vendor) {
          return {
            speech_credential_sid: credential.speech_credential_sid,
            api_key: credential.api_key,
            region: credential.region,
            use_custom_stt: credential.use_custom_stt,
            custom_stt_endpoint: credential.custom_stt_endpoint,
            use_custom_tts: credential.use_custom_tts,
            custom_tts_endpoint: credential.custom_tts_endpoint
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
            secret: credential.secret
          };
        }
        else if ('deepgram' === vendor) {
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
      }
      else {
        writeAlerts({
          alert_type: AlertType.STT_NOT_PROVISIONED,
          account_sid: this.accountSid,
          vendor
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

    while (this.tasks.length && !this.callGone) {
      const taskNum = ++this.taskIdx;
      const stackNum = this.stackIdx;
      const task = this.tasks.shift();
      this.logger.info(`CallSession:exec starting task #${stackNum}:${taskNum}: ${task.name}`);
      this._notifyTaskStatus(task, {event: 'starting'});
      try {
        const resources = await this._evaluatePreconditions(task);
        let skip = false;
        this.currentTask = task;
        if (TaskName.Gather === task.name && this.isBotModeEnabled) {
          if (this.backgroundGatherTask.updateTaskInProgress(task)) {
            this.logger.info(`CallSession:exec skipping #${stackNum}:${taskNum}: ${task.name}`);
            skip = true;
          }
          else {
            this.logger.info('CallSession:exec disabling bot mode to start gather with new options');
            this.disableBotMode();
          }
        }
        if (!skip) {
          const {span, ctx} = this.rootSpan.startChildSpan(`verb:${task.summary}`);
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

      if (0 === this.tasks.length && this.requestor instanceof WsRequestor && !this.callGone) {
        let span;
        try {
          const {span} = this.rootSpan.startChildSpan('waiting for commands');
          const {reason, queue, command} = await this._awaitCommandsOrHangup();
          span.setAttributes({
            'completion.reason': reason,
            'async.request.queue': queue,
            'async.request.command': command
          });
          span.end();
          if (this.callGone) break;
        } catch (err) {
          span.end();
          this.logger.info(err, 'CallSession:exec - error waiting for new commands');
          break;
        }
      }
    }

    // all done - cleanup
    this.logger.info('CallSession:exec all tasks complete');
    this._stopping = true;
    this.disableBotMode();
    this._onTasksDone();
    this._clearResources();


    if (!this.isConfirmCallSession && !this.isSmsCallSession) sessionTracker.remove(this.callSid);
  }

  trackTmpFile(path) {
    // TODO: don't add if its already in the list (should we make it a set?)
    this.logger.debug(`adding tmp file to track ${path}`);
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
    }
    else {
      /* we started a new app on the child leg, but nothing given for parent so hang him up */
      this.currentTask.kill(this);
    }
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

  async _lccMuteStatus(callSid, mute) {
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


  /**
   * perform live call control
   * @param {object} opts - update instructions
   * @param {string} callSid - identifies call toupdate
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
    else if (opts.mute_status) {
      await this._lccMuteStatus(callSid, opts.mute_status === 'mute');
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
    }
    else if (opts.record) {
      await this.notifyRecordOptions(opts.record);
    }

    // whisper may be the only thing we are asked to do, or it may that
    // we are doing a whisper after having muted, paused reccording etc..
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
    this.tasks = tasks;
    this.taskIdx = 0;
    this.stackIdx++;
    this.logger.info({tasks: listTaskNames(tasks)},
      `CallSession:replaceApplication reset with ${tasks.length} new tasks, stack depth is ${this.stackIdx}`);
    if (this.currentTask) {
      this.currentTask.kill(this, KillReason.Replaced);
      this.currentTask = null;
    }
  }

  kill(onBackgroundGatherBargein = false) {
    if (this.isConfirmCallSession) this.logger.debug('CallSession:kill (ConfirmSession)');
    else this.logger.info('CallSession:kill');
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
          this._bargeInEnabled = false;
          this.logger.info('CallSession:kill - found bargein disabled in the stack, clearing to that point');
          break;
        }
        this.tasks.shift();
      }
    }
    else this.tasks = [];
    this.taskIdx = 0;
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

    this.logger.debug({
      currentTaskList: listTaskNames(this.tasks),
      newContent: listTaskNames(newTasks),
      currentlyExecutingGather,
      gatherPos
    }, 'CallSession:_injectTasks - starting');

    const killGather = () => {
      this.logger.debug('CallSession:_injectTasks - killing current gather because we have new content');
      this.currentTask.kill(this);
    };

    if (-1 === gatherPos) {
      /* no gather in the stack  simply append tasks */
      this.tasks.push(...newTasks);
      this.logger.debug({
        updatedTaskList: listTaskNames(this.tasks)
      }, 'CallSession:_injectTasks - completed (simple append)');

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

  _onCommand({msgid, command, call_sid, queueCommand, data}) {
    this.logger.info({msgid, command, queueCommand}, 'CallSession:_onCommand - received command');
    const resolution = {reason: 'received command', queue: queueCommand, command};
    switch (command) {
      case 'redirect':
        if (Array.isArray(data)) {
          const t = normalizeJambones(this.logger, data)
            .map((tdata) => makeTask(this.logger, tdata));
          if (!queueCommand) {
            this.logger.info({tasks: listTaskNames(t)}, 'CallSession:_onCommand new task list');
            this.replaceApplication(t);
          }
          else if (process.env.JAMBONES_INJECT_CONTENT) {
            this.logger.debug({tasks: listTaskNames(t)}, 'CallSession:_onCommand - queueing tasks (injecting content)');
            this._injectTasks(t);
            this.logger.info({tasks: listTaskNames(this.tasks)}, 'CallSession:_onCommand - updated task list');
          }
          else {
            this.logger.debug({tasks: listTaskNames(t)}, 'CallSession:_onCommand - queueing tasks');
            this.tasks.push(...t);
            this.logger.info({tasks: listTaskNames(this.tasks)}, 'CallSession:_onCommand - updated task list');
          }
          resolution.command = listTaskNames(t);
        }
        else this._lccCallHook(data);
        break;

      case 'call:status':
        this._lccCallStatus(data);
        break;

      case 'mute:status':
        this._lccMuteStatus(call_sid, data);
        break;

      case 'conf:mute-status':
        this._lccConfMuteStatus(data);
        break;

      case 'conf:hold-status':
        this._lccConfHoldStatus(data);
        break;

      case 'listen:status':
        this._lccListenStatus(data);
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

      default:
        this.logger.info(`CallSession:_onCommand - invalid command ${command}`);
    }
    if (this.wakeupResolver) {
      this.logger.debug({resolution}, 'CallSession:_onCommand - got commands, waking up..');
      this.wakeupResolver(resolution);
      this.wakeupResolver = null;
    }
    else {
      const {span} = this.rootSpan.startChildSpan('async command');
      const {queue, command} = resolution;
      span.setAttributes({
        'async.request.queue': queue,
        'async.request.command': command
      });
      span.end();
    }
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

      // we are going from an early media connection to answer
      await this.propagateAnswer();
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
      this.logger.debug(`allocated endpoint ${ep.uuid}`);

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
    this.ep = await this.ms.createEndpoint({remoteSdp: this.dlg.remote.sdp});

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
  }

  /**
   * called when the caller has hung up.  Provided for subclasses to override
   * in order to apply logic at this point if needed.
   */
  _callerHungup() {
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

      this.logger.debug(`CallSession:propagateAnswer - answered callSid ${this.callSid}`);
    }
  }

  async _onReinvite(req, res) {
    try {
      if (this.ep) {
        if (this.isSipRecCallSession) {
          this.logger.info('handling reINVITE for siprec call');
          res.send(200, {body: this.ep.local.sdp});
        }
        else {
          const newSdp = await this.ep.modify(req.body);
          res.send(200, {body: newSdp});
          this.logger.info({offer: req.body, answer: newSdp}, 'handling reINVITE');
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
   * Handle incoming REFER if we are in a dial task
   * @param {*} req
   * @param {*} res
   */
  _onRefer(req, res) {
    const task = this.currentTask;
    const sd = task.sd;
    if (task && TaskName.Dial === task.name && sd) {
      task.handleRefer(this, req, res);
    }
    else {
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
        const [r] = await pp.query(sqlRetrieveQueueEventHook, this.accountSid);
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
    dlg.destroy = () => {
      if (dlg.connected) {
        dlg.connected = false;
        dlg.destroy = origDestroy;
        const duration = moment().diff(this.dlg.connectTime, 'seconds');
        this.callInfo.callTerminationBy = 'jambonz';
        this.emit('callStatusChange', {callStatus: CallStatus.Completed, duration});
        this.logger.debug('CallSession: call terminated by jambonz');
        this.rootSpan.setAttributes({'call.termination': 'hangup by jambonz'});
        origDestroy().catch((err) => this.logger.info({err}, 'CallSession - error destroying dialog'));
        if (this.wakeupResolver) {
          this.wakeupResolver({reason: 'session ended'});
          this.wakeupResolver = null;
        }
      }
    };
  }

  async releaseMediaToSBC(remoteSdp) {
    assert(this.dlg && this.dlg.connected && this.ep && typeof remoteSdp === 'string');
    await this.dlg.modify(remoteSdp, {
      headers: {
        'X-Reason': 'release-media'
      }
    });
    this.ep.destroy()
      .then(() => this.ep = null)
      .catch((err) => this.logger.error({err}, 'CallSession:releaseMediaToSBC: Error destroying endpoint'));
  }

  async reAnchorMedia() {
    assert(this.dlg && this.dlg.connected && !this.ep);
    this.ep = await this.ms.createEndpoint({remoteSdp: this.dlg.remote.sdp});
    await this.dlg.modify(this.ep.local.sdp, {
      headers: {
        'X-Reason': 'anchor-media'
      }
    });
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

    // update calls db
    //this.logger.debug(`updating redis with ${JSON.stringify(this.callInfo)}`);
    this.updateCallStatus(Object.assign({}, this.callInfo.toJSON()), this.serviceUrl)
      .catch((err) => this.logger.error(err, 'redis error'));
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
}

module.exports = CallSession;
