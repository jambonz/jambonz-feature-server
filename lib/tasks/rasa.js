const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const makeTask = require('./make_task');
const bent = require('bent');

class Rasa extends Task {
  constructor(logger, opts) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.prompt = this.data.prompt;
    this.eventHook = this.data?.eventHook;
    this.actionHook = this.data?.actionHook;
    this.post = bent('POST', 'json', 200);
  }

  get name() { return TaskName.Rasa; }

  get hasReportedFinalAction() {
    return this.reportedFinalAction || this.isReplacingApplication;
  }

  async exec(cs, {ep}) {
    await super.exec(cs);

    this.ep = ep;
    try {
      /* set event handlers */
      this.on('transcription', this._onTranscription.bind(this, cs, ep));
      this.on('timeout', this._onTimeout.bind(this, cs, ep));

      /* start the first gather */
      this.gatherTask = this._makeGatherTask(this.prompt);
      const {span, ctx} = this.startChildSpan(`nested:${this.gatherTask.summary}`);
      this.gatherTask.span = span;
      this.gatherTask.ctx = ctx;
      this.gatherTask.exec(cs, {ep})
        .then(() => span.end())
        .catch((err) => {
          span.end();
          this.logger.info({err}, 'Rasa gather task returned error');
        });

      await this.awaitTaskDone();
    } catch (err) {
      this.logger.error({err}, 'Rasa error');
      throw err;
    }
  }

  async kill(cs) {
    super.kill(cs);
    this.logger.debug('Rasa:kill');

    if (!this.hasReportedFinalAction) {
      this.reportedFinalAction = true;
      this.performAction({rasaResult: 'caller hungup'})
        .catch((err) => this.logger.info({err}, 'rasa - error w/ action webook'));
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

  async _onTranscription(cs, ep, evt) {
    //this.logger.debug({evt}, `Rasa: got transcription for callSid ${cs.callSid}`);
    const utterance = evt.alternatives[0].transcript;

    if (this.eventHook) {
      this.performHook(cs, this.eventHook, {event: 'userMessage', message: utterance})
        .then((redirected) => {
          if (redirected) {
            this.logger.info('Rasa_onTranscription: event handler for user message redirected us to new webhook');
            this.reportedFinalAction = true;
            this.performAction({rasaResult: 'redirect'}, false);
            if (this.gatherTask) this.gatherTask.kill(cs);
          }
          return;
        })
        .catch(({err}) => {
          this.logger.info({err}, 'Rasa_onTranscription: error sending event hook');
        });
    }

    try {
      const payload = {
        sender: cs.callSid,
        message: utterance
      };
      this.logger.debug({payload}, 'Rasa:_onTranscription - sending payload to Rasa');
      const response = await this.post(this.data.url, payload);
      this.logger.debug({response}, 'Rasa:_onTranscription - got response from Rasa');
      const botUtterance = Array.isArray(response) ?
        response.reduce((prev, current) => {
          return current.text ? `${prev} ${current.text}` : '';
        }, '') :
        null;
      if (botUtterance) {
        this.logger.debug({botUtterance}, 'Rasa:_onTranscription: got user utterance');
        this.gatherTask = this._makeGatherTask(botUtterance);
        const {span, ctx} = this.startChildSpan(`nested:${this.gatherTask.summary}`);
        this.gatherTask.span = span;
        this.gatherTask.ctx = ctx;
        this.gatherTask.exec(cs, {ep})
          .then(() => span.end())
          .catch((err) => {
            span.end();
            this.logger.info({err}, 'Rasa gather task returned error');
          });
        if (this.eventHook) {
          this.performHook(cs, this.eventHook, {event: 'botMessage', message: response})
            .then((redirected) => {
              if (redirected) {
                this.logger.info('Rasa_onTranscription: event handler for bot message redirected us to new webhook');
                this.reportedFinalAction = true;
                this.performAction({rasaResult: 'redirect'}, false);
                if (this.gatherTask) this.gatherTask.kill(cs);
              }
              return;
            })
            .catch(({err}) => {
              this.logger.info({err}, 'Rasa_onTranscription: error sending event hook');
            });
        }
      }
    } catch (err) {
      this.logger.error({err}, 'Rasa_onTranscription: Error sending user utterance to Rasa - ending task');
      this.performAction({rasaResult: 'webhookError'});
      this.reportedFinalAction = true;
      this.notifyTaskDone();
    }
  }
  _onTimeout(cs, ep, evt) {
    this.logger.debug({evt}, 'Rasa: got timeout');
    if (!this.hasReportedFinalAction) this.performAction({rasaResult: 'timeout'});
    this.reportedFinalAction = true;
    this.notifyTaskDone();
  }


}

module.exports = Rasa;
