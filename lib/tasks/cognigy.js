const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const makeTask = require('./make_task');
const { SocketClient } = require('@cognigy/socket-client');

class Cognigy extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.url = this.data.url;
    this.token = this.data.token;
    this.prompt = this.data.prompt;
    this.eventHook = this.data?.eventHook;
    this.actionHook = this.data?.actionHook;
  }

  get name() { return TaskName.Cognigy; }

  get hasReportedFinalAction() {
    return this.reportedFinalAction || this.isReplacingApplication;
  }

  async exec(cs, ep) {
    await super.exec(cs);

    this.ep = ep;
    try {
      /* set event handlers */
      this.on('transcription', this._onTranscription.bind(this, cs, ep));
      this.on('timeout', this._onTimeout.bind(this, cs, ep));

      /* connect to the bot */
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

      /* start the first gather */
      this.gatherTask = this._makeGatherTask(this.prompt);
      this.gatherTask.exec(cs, ep, this)
        .catch((err) => this.logger.info({err}, 'Cognigy gather task returned error'));

      await this.client.connect();
      await this.awaitTaskDone();
    } catch (err) {
      this.logger.error({err}, 'Cognigy error');
      throw err;
    }
  }

  async kill(cs) {
    super.kill(cs);
    this.logger.debug('Cognigy:kill');

    if (this.client && this.client.connected) this.client.disconnect();

    if (!this.hasReportedFinalAction) {
      this.reportedFinalAction = true;
      this.performAction({cognigyResult: 'caller hungup'})
        .catch((err) => this.logger.info({err}, 'cognigy - error w/ action webook'));
    }

    if (this.ep.connected) {
      await this.ep.api('uuid_break', this.ep.uuid).catch((err) => this.logger.info(err, 'Error killing audio'));
    }
    this.removeAllListeners();
    this.notifyTaskDone();
  }

  _makeGatherTask(prompt) {
    let opts = {
      input: ['speech'],
      timeout: this.data.timeout || 10,
      recognizer: this.data.recognizer || {
        vendor: 'default',
        language: 'default'
      }
    };
    if (prompt) {
      const sayOpts = this.data.tts ?
        {text: prompt, synthesizer: this.data.tts} :
        {text: prompt};

      opts = {
        ...opts,
        say: sayOpts
      };
    }
    //this.logger.debug({opts}, 'constructing a nested gather object');
    const gather = makeTask(this.logger, {gather: opts}, this);
    return gather;
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
    //this.notifyTaskDone();
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
            if (this.gatherTask) this.gatherTask.kill(cs);
          }
          return;
        })
        .catch(({err}) => {
          this.logger.info({err}, 'Cognigy_onTranscription: error sending event hook');
        });
    }

    let response = evt.text || 
    evt?.data?.text;
    if (Array.isArray(response)) response = response[0];

    if (response && !this.killed) {
      //this.gatherTask.kill(cs);
      this.gatherTask = this._makeGatherTask(response);
      this.gatherTask.exec(cs, ep, this)
        .catch((err) => this.logger.info({err}, 'Cognigy gather task returned error'));
      if (this.eventHook) {
        this.performHook(cs, this.eventHook, {event: 'botMessage', message: response})
          .then((redirected) => {
            if (redirected) {
              this.logger.info('Cognigy: event handler for bot message redirected us to new webhook');
              this.reportedFinalAction = true;
              this.performAction({rasaResult: 'redirect'}, false);
              if (this.gatherTask) this.gatherTask.kill(cs);
            }
            return;
          })
          .catch(({err}) => {
            this.logger.info({err}, 'Cognigy:_onBotUtterance error sending event hook');
          });
      }
    }
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
            if (this.gatherTask) this.gatherTask.kill(cs);
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
  _onTimeout(cs, ep, evt) {
    this.logger.debug({evt}, 'Cognigy: got timeout');
    if (!this.hasReportedFinalAction) this.performAction({cognigyResult: 'timeout'});
    this.reportedFinalAction = true;
    this.notifyTaskDone();
  }
}

module.exports = Cognigy;
