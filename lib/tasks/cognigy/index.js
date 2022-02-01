const Task = require('../task');
const {TaskName, TaskPreconditions} = require('../../utils/constants');
const makeTask = require('../make_task');
const { SocketClient } = require('@cognigy/socket-client');
const SpeechConfig = require('./speech-config');

const parseGallery = (obj = {}) => {
  const {_default} = obj;
  if (_default) {
    const {_gallery} = _default;
    if (_gallery) return _gallery.fallbackText;
  }
};

const parseQuickReplies = (obj) => {
  const {_default} = obj;
  if (_default) {
    const {_quickReplies} = _default;
    if (_quickReplies) return _quickReplies.text || _quickReplies.fallbackText;
  }
};

const parseBotText = (evt) => {
  const {text, data} = evt;
  if (text) return text;

  switch (data?.type) {
    case 'quickReplies':
      return parseQuickReplies(data?._cognigy);
    case 'gallery':
      return parseGallery(data?._cognigy);
    default:
      break;
  }
};

class Cognigy extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.url = this.data.url;
    this.token = this.data.token;
    this.prompt = this.data.prompt;
    this.eventHook = this.data?.eventHook;
    this.actionHook = this.data?.actionHook;
    this.data = this.data.data || {};
    this.prompts = [];
    this.retry = {};
    this.timeoutCount = 0;
  }

  get name() { return TaskName.Cognigy; }

  get hasReportedFinalAction() {
    return this.reportedFinalAction || this.isReplacingApplication;
  }

  async exec(cs, ep) {
    await super.exec(cs);

    const opts = {
      session: {
        synthesizer: this.data.synthesizer || {
          vendor: 'default',
          language: 'default',
          voice: 'default'
        },
        recognizer: this.data.recognizer || {
          vendor: 'default',
          language: 'default'
        },
        bargein: this.data.bargein || {},
        bot: this.data.bot || {},
        user: this.data.user || {},
        dtmf: this.data.dtmf || {}
      }
    };
    this.config = new SpeechConfig({logger: this.logger, ep, opts});
    this.ep = ep;
    try {

      /* set event handlers and start transcribing */
      this.on('transcription', this._onTranscription.bind(this, cs, ep));
      this.on('dtmf-collected', this._onDtmf.bind(this, cs, ep));
      this.on('timeout', this._onTimeout.bind(this, cs, ep));
      this.on('error', this._onError.bind(this, cs, ep));

      /* connect to the bot and send initial data */
      this.client = new SocketClient(
        this.url,
        this.token,
        {
          sessionId: cs.callSid,
          channel: 'jambonz',
          forceWebsockets: true,
          reconnection: true,
          settings: {
            enableTypingIndicator: false
          }
        }
      );
      this.client.on('output', this._onBotUtterance.bind(this, cs, ep));
      this.client.on('error', this._onBotError.bind(this, cs, ep));
      this.client.on('finalPing', this._onBotFinalPing.bind(this, cs, ep));
      await this.client.connect();
      // todo make welcome message configurable (enable or disable it when
      // we start a conversation (should be enabled by defaul))
      this.client.sendMessage('Welcome Message', {...this.data, ...cs.callInfo});

      await this.awaitTaskDone();
    } catch (err) {
      this.logger.error({err}, 'Cognigy error');
      throw err;
    }
  }

  async kill(cs) {
    super.kill(cs);
    this.logger.debug('Cognigy:kill');

    this.removeAllListeners();
    this.transcribeTask && this.transcribeTask.kill();

    this.client.removeAllListeners();
    if (this.client && this.client.connected) this.client.disconnect();

    if (!this.hasReportedFinalAction) {
      this.reportedFinalAction = true;
      this.performAction({cognigyResult: 'caller hungup'})
        .catch((err) => this.logger.info({err}, 'cognigy - error w/ action webook'));
    }

    if (this.ep.connected) {
      await this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
    }
    this.notifyTaskDone();
  }

  _makeGatherTask({textPrompt, urlPrompt}) {
    const config = this.config.makeGatherTaskConfig({textPrompt, urlPrompt});
    const {retry, ...rest} = config;
    this.retry = retry;
    const gather = makeTask(this.logger, {gather: rest}, this);
    return gather;
  }

  _makeSayTask(text) {
    const opts = {
      text,
      synthesizer: this.data.synthesizer ||
      {
        vendor: 'default',
        language: 'default',
        voice: 'default'
      }
    };
    const say = makeTask(this.logger, {say: opts}, this);
    return say;
  }

  _makeHangupTask(reason) {
    const hangup = makeTask(this.logger, {hangup: {
      headers: {
        'X-REASON': reason
      }
    }}, this);
    return hangup;
  }

  _makeReferTask(number) {
    const refer = makeTask(this.logger, {'sip:refer': {
      referTo: number,
      referredBy: 'cognigy'
    }});
    return refer;
  }

  async _onBotError(cs, ep, evt) {
    this.logger.info({evt}, 'Cognigy:_onBotError');
    this.performAction({cognigyResult: 'botError', message: evt.message });
    this.reportedFinalAction = true;
    this.notifyTaskDone();
  }

  async _onBotFinalPing(cs, ep) {
    this.logger.info({}, 'TEST FROM ALEX');
    this.logger.info({prompts: this.prompts}, 'Cognigy:_onBotFinalPing');
    if (this.prompts.length) {
      const text = this.prompts.join('.');
      if (text && !this.killed) {
        this.gatherTask = this._makeGatherTask({textPrompt: text});
        this.gatherTask.exec(cs, ep, this)
          .catch((err) => this.logger.info({err}, 'Cognigy gather task returned error'));
      }
    }
    this.prompts = [];
  }

  async _onBotUtterance(cs, ep, evt) {
    this.logger.debug({evt}, 'Cognigy:_onBotUtterance');

    if (this.eventHook) {
      this.performHook(cs, this.eventHook, {event: 'botMessage', message: evt})
        .then((redirected) => {
          if (redirected) {
            this.logger.info('Cognigy_onBotUtterance: event handler for bot message redirected us to new webhook');
            this.reportedFinalAction = true;
            this.performAction({cognigyResult: 'redirect'}, false);
          }
          return;
        })
        .catch(({err}) => {
          this.logger.info({err}, 'Cognigy_onBotUtterance: error sending event hook');
        });
    }

    if (evt && evt.data && evt.data.type) {
      try {
        switch (evt.data.type) {
          case 'hangup':
            await this._makeHangupTask(evt.data.reason);
            this.performAction({cognigyResult: 'hangup Succeeded'});
            this.reportedFinalAction = true;
            this.notifyTaskDone();
            return;
          case 'refer':
            await this._makeReferTask(evt.data.number);
            this.performAction({cognigyResult: 'refer succeeded'});
            this.reportedFinalAction = true;
            this.notifyTaskDone();
            return;
          default:
            break;
        }
      } catch (err) {
        this.logger.info({err, evtData: evt.data}, 'encountered error exeuting task');
        if (!this.hasReportedFinalAction) this.performAction({cognigyResult: 'error', err});
        this.reportedFinalAction = true;
        this.notifyTaskDone();
      }


    }
    const text = parseBotText(evt);
    if (evt.data) this.config.update(evt.data);
    if (text) this.prompts.push(text);
  }

  async _onTranscription(cs, ep, evt) {
    this.logger.debug({evt}, `Cognigy: got transcription for callSid ${cs.callSid}`);
    const utterance = evt.alternatives[0].transcript;

    if (this.eventHook) {
      this.performHook(cs, this.eventHook, {event: 'userMessage', message: utterance})
        .then((redirected) => {
          if (redirected) {
            this.logger.info('Cognigy_onTranscription: event handler for user message redirected us to new webhook');
            this.reportedFinalAction = true;
            this.performAction({cognigyResult: 'redirect'}, false);
            if (this.transcribeTask) this.transcribeTask.kill(cs);
          }
          return;
        })
        .catch(({err}) => {
          this.logger.info({err}, 'Cognigy_onTranscription: error sending event hook');
        });
    }

    /* send the user utterance to the bot */
    try {
      if (this.client && this.client.connected) {
        this.client.sendMessage(utterance);
      }
      else {
        // if the bot is not connected, should we maybe throw an error here?
        this.logger.info('Cognigy_onTranscription - not sending user utterance as bot is disconnected');
      }
    } catch (err) {
      this.logger.error({err}, 'Cognigy_onTranscription: Error sending user utterance to Cognigy - ending task');
      this.performAction({cognigyResult: 'socketError'});
      this.reportedFinalAction = true;
      this.notifyTaskDone();
    }
  }

  _onDtmf(cs, ep, evt) {
    this.logger.info({evt}, 'got dtmf');

    /* send dtmf to bot */
    try {
      if (this.client && this.client.connected) {
        this.client.sendMessage(evt.digits);
      }
      else {
        // if the bot is not connected, should we maybe throw an error here?
        this.logger.info('Cognigy_onTranscription - not sending user dtmf as bot is disconnected');
      }
    } catch (err) {
      this.logger.error({err}, '_onDtmf: Error sending user dtmf to Cognigy - ending task');
      this.performAction({cognigyResult: 'socketError'});
      this.reportedFinalAction = true;
      this.notifyTaskDone();
    }
  }
  _onError(cs, ep, err) {
    this.logger.info({err}, 'Cognigy: got error');
    if (!this.hasReportedFinalAction) this.performAction({cognigyResult: 'error', err});
    this.reportedFinalAction = true;
    this.notifyTaskDone();
  }

  _onTimeout(cs, ep, evt) {
    const {noInputRetries, noInputSpeech, noInputUrl} = this.retry;
    this.logger.debug({evt, retry: this.retry}, 'Cognigy: got timeout');
    if (noInputRetries && this.timeoutCount++ < noInputRetries) {
      this.gatherTask = this._makeGatherTask({textPrompt: noInputSpeech, urlPrompt: noInputUrl});
      this.gatherTask.exec(cs, ep, this)
        .catch((err) => this.logger.info({err}, 'Cognigy gather task returned error'));
    }
    else {
      if (!this.hasReportedFinalAction) this.performAction({cognigyResult: 'timeout'});
      this.reportedFinalAction = true;
      this.notifyTaskDone();
    }
  }
}

module.exports = Cognigy;
