const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

class TaskSay extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.text = Array.isArray(this.data.text) ? this.data.text : [this.data.text];
    this.loop = this.data.loop || 1;
    this.earlyMedia = this.data.earlyMedia === true || (parentTask && parentTask.earlyMedia);
    this.synthesizer = this.data.synthesizer || {};
  }

  get name() { return TaskName.Say; }

  get summary() {
    for (let i = 0; i < this.text.length; i++) {
      if (this.text[i].startsWith('silence_stream')) continue;
      return `${this.name}{text=${this.text[i].slice(0, 15)}${this.text[i].length > 15 ? '...' : ''}}`;
    }
    return `${this.name}{${this.text[0]}}`;
  }

  async exec(cs, ep) {
    await super.exec(cs);

    const {srf} = cs;
    const {updateSpeechCredentialLastUsed} = require('../utils/db-utils')(this.logger, srf);
    const {writeAlerts, AlertType, stats} = srf.locals;
    const {synthAudio} = srf.locals.dbHelpers;
    const vendor = this.synthesizer.vendor && this.synthesizer.vendor !== 'default' ?
      this.synthesizer.vendor :
      cs.speechSynthesisVendor;
    const language = this.synthesizer.language && this.synthesizer.language !== 'default' ?
      this.synthesizer.language :
      cs.speechSynthesisLanguage ;
    const voice =  this.synthesizer.voice && this.synthesizer.voice !== 'default' ?
      this.synthesizer.voice :
      cs.speechSynthesisVoice;
    const engine = this.synthesizer.engine || 'standard';
    const salt = cs.callSid;
    const credentials = cs.getSpeechCredentials(vendor, 'tts');

    this.logger.info({vendor, language, voice}, 'TaskSay:exec');
    this.ep = ep;
    try {
      if (!credentials) {
        writeAlerts({
          account_sid: cs.accountSid,
          alert_type: AlertType.TTS_NOT_PROVISIONED,
          vendor
        }).catch((err) => this.logger.info({err}, 'Error generating alert for no tts'));
        throw new Error('no provisioned speech credentials for TTS');
      }
      // synthesize all of the text elements
      let lastUpdated = false;

      /* otel: trace time for tts */
      const {span} = this.startChildSpan('tts-generation', {
        'tts.vendor': vendor,
        'tts.language': language,
        'tts.voice': voice
      });
      this.ttsSpan = span;

      const filepath = (await Promise.all(this.text.map(async(text) => {
        if (this.killed) return;
        if (text.startsWith('silence_stream://')) return text;
        const {filePath, servedFromCache} = await synthAudio(stats, {
          text,
          vendor,
          language,
          voice,
          engine,
          salt,
          credentials
        }).catch((err) => {
          this.logger.info(err, 'Error synthesizing tts');
          writeAlerts({
            account_sid: cs.accountSid,
            alert_type: AlertType.TTS_NOT_PROVISIONED,
            vendor,
            detail: err.message
          });
        }).catch((err) => this.logger.info({err}, 'Error generating alert for tts failure'));
        this.logger.debug(`file ${filePath}, served from cache ${servedFromCache}`);
        if (filePath) cs.trackTmpFile(filePath);
        if (!servedFromCache && !lastUpdated) {
          lastUpdated = true;
          updateSpeechCredentialLastUsed(credentials.speech_credential_sid)
            .catch(() => {/*already logged error */});
        }
        this.ttsSpan.setAttributes({'tts.cached': servedFromCache});
        return filePath;
      }))).filter((fp) => fp && fp.length);
      this.ttsSpan?.end();
      this.logger.debug({filepath}, 'synthesized files for tts');

      while (!this.killed && (this.loop === 'forever' || this.loop--) && this.ep?.connected) {
        let segment = 0;
        do {
          if (cs.isInConference) {
            const {memberId, confName, confUuid} = cs;
            await this.playToConfMember(this.ep, memberId, confName, confUuid, filepath[segment]);
          }
          else {
            this.logger.debug(`Say:exec sending command to play file ${filepath[segment]}`);
            await ep.play(filepath[segment]);
            this.logger.debug(`Say:exec completed play file ${filepath[segment]}`);
          }
        } while (!this.killed && ++segment < filepath.length);
      }
    } catch (err) {
      this.ttsSpan?.end();
      this.logger.info(err, 'TaskSay:exec error');
    }
    this.emit('playDone');
  }

  async kill(cs) {
    super.kill(cs);
    if (this.ep.connected) {
      this.logger.debug('TaskSay:kill - killing audio');
      if (cs.isInConference) {
        const {memberId, confName} = cs;
        this.killPlayToConfMember(this.ep, memberId, confName);
      }
      else {
        this.ep.api('uuid_break', this.ep.uuid);
      }
    }
  }
}

module.exports = TaskSay;
