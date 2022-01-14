const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const makeTask = require('./make_task');
const { SocketClient } = require('@cognigy/socket-client');

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
  }

  get name() { return TaskName.Cognigy; }

  get hasReportedFinalAction() {
    return this.reportedFinalAction || this.isReplacingApplication;
  }

  async exec(cs, ep) {
    await super.exec(cs);

    this.ep = ep;
    try {
      /* set event handlers and start transcribing */
      this.on('transcription', this._onTranscription.bind(this, cs, ep));
      this.on('error', this._onError.bind(this, cs, ep));

      this.transcribeTask = this._makeTranscribeTask();
      this.transcribeTask.exec(cs, ep, this)
        .catch((err) => {
          this.logger.info({err}, 'Cognigy transcribe task returned error');
          this.notifyTaskDone();
        });
      if (this.prompt) {
        this.sayTask = this._makeSayTask(this.prompt);
        this.sayTask.exec(cs, ep, this)
          .catch((err) => {
            this.logger.info({err}, 'Cognigy say task returned error');
            this.notifyTaskDone();
          });
      }

      /* connect to the bot and send initial data */
      this.client = new SocketClient(
        this.url,
        this.token,
        {
          sessionId: cs.callSid,
          channel: 'jambonz'
        }
      );
      this.client.on('output', this._onBotUtterance.bind(this, cs, ep));
      this.client.on('typingStatus', this._onBotTypingStatus.bind(this, cs, ep));
      this.client.on('error', this._onBotError.bind(this, cs, ep));
      this.client.on('finalPing', this._onBotFinalPing.bind(this, cs, ep));
      await this.client.connect();
      this.client.sendMessage('', {...this.data, ...cs.callInfo});

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

  _makeTranscribeTask() {
    const opts = {
      recognizer: this.data.recognizer || {
        vendor: 'default',
        language: 'default',
        outputFormat: 'detailed'
      }
    };
    this.logger.debug({opts}, 'constructing a nested transcribe object');
    const transcribe = makeTask(this.logger, {transcribe: opts}, this);
    return transcribe;
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
    this.logger.debug({opts}, 'constructing a nested say object');
    const say = makeTask(this.logger, {say: opts}, this);
    return say;
  }

  async _onBotError(cs, ep, evt) {
    this.logger.info({evt}, 'Cognigy:_onBotError');
    this.performAction({cognigyResult: 'botError', message: evt.message });
    this.reportedFinalAction = true;
    this.notifyTaskDone();
  }

  async _onBotTypingStatus(cs, ep, evt) {
    this.logger.info({evt}, 'Cognigy:_onBotTypingStatus');
  }
  async _onBotFinalPing(cs, ep) {
    this.logger.info('Cognigy:_onBotFinalPing');
    if (this.prompts.length) {
      const text = this.prompts.join('.');
      this.prompts = [];
      if (text && !this.killed) {
        this.sayTask = this._makeSayTask(text);
        this.sayTask.exec(cs, ep, this)
          .catch((err) => {
            this.logger.info({err}, 'Cognigy say task returned error');
            this.notifyTaskDone();
          });
      }
    }
  }

  async _onBotUtterance(cs, ep, evt) {
    this.logger.debug({evt}, 'Cognigy:_onBotUtterance');

    if (this.eventHook) {
      this.performHook(cs, this.eventHook, {event: 'botMessage', message: evt})
        .then((redirected) => {
          if (redirected) {
            this.logger.info('Cognigy_onTranscription: event handler for bot message redirected us to new webhook');
            this.reportedFinalAction = true;
            this.performAction({cognigyResult: 'redirect'}, false);
          }
          return;
        })
        .catch(({err}) => {
          this.logger.info({err}, 'Cognigy_onTranscription: error sending event hook');
        });
    }
    const text = parseBotText(evt);
    this.prompts.push(text);
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
        this.logger.info('Cognigy_onTranscription - not sending user utterance as bot is disconnected');
      }
    } catch (err) {
      this.logger.error({err}, 'Cognigy_onTranscription: Error sending user utterance to Cognigy - ending task');
      this.performAction({cognigyResult: 'socketError'});
      this.reportedFinalAction = true;
      this.notifyTaskDone();
    }
  }
  _onError(cs, ep, err) {
    this.logger.debug({err}, 'Cognigy: got error');
    if (!this.hasReportedFinalAction) this.performAction({cognigyResult: 'error', err});
    this.reportedFinalAction = true;
    this.notifyTaskDone();
  }
}

module.exports = Cognigy;
