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

  async exec(cs, ep) {
    await super.exec(cs);

    this.ep = ep;
    try {
      /* set event handlers */
      this.on('transcription', this._onTranscription.bind(this, cs, ep));
      this.on('timeout', this._onTimeout.bind(this, cs, ep));

      /* start the first gather */
      this.gatherTask = this._makeGatherTask(this.prompt);
      this.gatherTask.exec(cs, ep, this)
        .catch((err) => this.logger.info({err}, 'Rasa gather task returned error'));

      await this.awaitTaskDone();
    } catch (err) {
      this.logger.error({err}, 'Rasa error');
      throw err;
    }
  }

  async kill(cs) {
    super.kill(cs);
    if (this.ep.connected) {
      this.logger.debug('Rasa:kill');

      this.performAction({rasaResult: 'caller hungup'})
        .catch((err) => this.logger.error({err}, 'rasa - error w/ action webook'));

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
    this.logger.debug({opts}, 'constructing a nested gather object');
    const gather = makeTask(this.logger, {gather: opts}, this);
    return gather;
  }

  async _onTranscription(cs, ep, evt) {
    this.logger.debug({evt}, `Rasa: got transcription for callSid ${cs.callSid}`);
    const utterance = evt.alternatives[0].transcript;
    try {
      const payload = {
        sender: cs.callSid,
        message: utterance
      };
      this.logger.debug({payload}, 'Rasa:_onTranscription - sending payload to Rasa');
      const response = await this.post(this.data.url, payload);
      this.logger.debug({response}, 'Rasa:_onTranscription - got response from Rasa');
      const botUtterance = Array.isArray(response) ?
        response.reduce((prev, current) => `${prev} ${current.text}`, '') :
        null;
      if (botUtterance) {
        this.logger.debug({botUtterance}, 'playing out bot utterance');
        this.gatherTask = this._makeGatherTask(botUtterance);
        this.gatherTask.exec(cs, ep, this)
          .catch((err) => this.logger.info({err}, 'Rasa gather task returned error'));
      }
    } catch (err) {
      this.logger.error({err}, 'Error sending');
    }
  }
  _onTimeout(cs, ep, evt) {
    this.logger.debug({evt}, 'Rasa: got timeout');
  }


}

module.exports = Rasa;
