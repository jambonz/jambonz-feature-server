const Task = require('./task');
const {TaskName, TaskPreconditions} = require('../utils/constants');

const breakLengthyTextIfNeeded = (logger,  text) => {
  const chunkSize = 1000;
  if (text.length <= chunkSize) return [text];

  const result = [];
  const isSSML = text.startsWith('<speak>');
  let startPos = 0;
  let charPos = isSSML ? 7 : 0;  // skip <speak>
  let tag;
  //logger.debug({isSSML}, `breakLengthyTextIfNeeded: handling text of length ${text.length}`);
  while (startPos + charPos < text.length) {
    if (isSSML && !tag && text[startPos + charPos] === '<') {
      const tagStartPos = ++charPos;
      while (startPos + charPos < text.length) {
        if (text[startPos + charPos] === '>') {
          if (text[startPos + charPos - 1] === '\\') tag = null;
          else if (!tag) tag = text.substring(startPos + tagStartPos, startPos + charPos - 1);
          break;
        }
        if (!tag) {
          const c = text[startPos + charPos];
          if (c === ' ') {
            tag = text.substring(startPos + tagStartPos, startPos + charPos);
            //logger.debug(`breakLengthyTextIfNeeded: enter tag ${tag} (space)`);
            break;
          }
        }
        charPos++;
      }
      if (tag) {
        //search for end of tag
        //logger.debug(`breakLengthyTextIfNeeded: searching forward for </${tag}>`);
        const e1 = text.indexOf(`</${tag}>`, startPos + charPos);
        const e2 = text.indexOf('/>', startPos + charPos);
        const tagEndPos = e1 === -1 ? e2 : e2 === -1 ? e1 : Math.min(e1, e2);
        if (tagEndPos === -1) {
          //logger.debug(`breakLengthyTextIfNeeded: exit tag ${tag} not found, exiting`);
        } else {
          //logger.debug(`breakLengthyTextIfNeeded: exit tag ${tag} found at ${tagEndPos}`);
          charPos = tagEndPos + 1;
        }
        tag = null;
      }
      continue;
    }

    if (charPos < chunkSize) {
      charPos++;
      continue;
    }

    // start looking for a good break point
    let chunkIt = false;
    const a = text[startPos + charPos];
    const b = text[startPos + charPos + 1];
    if (/[\.!\?]/.test(a) && /\s/.test(b)) {
      //logger.debug('breakLengthyTextIfNeeded: breaking at sentence end');
      chunkIt = true;
    }
    if (chunkIt) {
      charPos++;
      const chunk = text.substr(startPos, charPos);
      if (isSSML) {
        result.push(0 === startPos ? `${chunk}</speak>` : `<speak>${chunk}</speak>`);
      }
      else result.push(chunk);
      charPos = 0;
      startPos += chunk.length;

      //logger.debug({chunk: result[result.length - 1]},
      //  `breakLengthyTextIfNeeded: chunked; new starting pos ${startPos}`);

    }
    else charPos++;
  }

  // final chunk
  if (startPos < text.length) {
    const chunk = text.substr(startPos);
    if (isSSML) {
      result.push(0 === startPos ? `${chunk}</speak>` : `<speak>${chunk}`);
    }
    else result.push(chunk);

    //logger.debug({chunk: result[result.length - 1]},
    //  `breakLengthyTextIfNeeded: final chunk; starting pos ${startPos} length ${chunk.length}`);

  }

  return result;
};

class TaskSay extends Task {
  constructor(logger, opts, parentTask) {
    super(logger, opts);
    this.preconditions = TaskPreconditions.Endpoint;

    this.text = (Array.isArray(this.data.text) ? this.data.text : [this.data.text])
      .map((t) => breakLengthyTextIfNeeded(this.logger, t))
      .flat();

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

  async exec(cs, {ep}) {
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
    let voice =  this.synthesizer.voice && this.synthesizer.voice !== 'default' ?
      this.synthesizer.voice :
      cs.speechSynthesisVoice;
    const engine = this.synthesizer.engine || 'standard';
    const salt = cs.callSid;
    const credentials = cs.getSpeechCredentials(vendor, 'tts');

    /* parse Nuance voices into name and model */
    let model;
    if (vendor === 'nuance' && voice) {
      const arr = /([A-Za-z-]*)\s+-\s+(enhanced|standard)/.exec(voice);
      if (arr) {
        voice = arr[1];
        model = arr[2];
      }
    }

    this.logger.info({vendor, language, voice, model}, 'TaskSay:exec');
    this.ep = ep;
    try {
      if (!credentials) {
        writeAlerts({
          account_sid: cs.accountSid,
          alert_type: AlertType.TTS_NOT_PROVISIONED,
          vendor
        }).catch((err) => this.logger.info({err}, 'Error generating alert for no tts'));
        this.notifyError({
          msg: 'TTS error',
          details:`No speech credentials provisioned for selected vendor ${vendor}`
        });
        throw new Error('no provisioned speech credentials for TTS');
      }
      // synthesize all of the text elements
      let lastUpdated = false;

      /* produce an audio segment from the provided text */
      const generateAudio = async(text) => {
        if (this.killed) return;
        if (text.startsWith('silence_stream://')) return text;

        /* otel: trace time for tts */
        const {span} = this.startChildSpan('tts-generation', {
          'tts.vendor': vendor,
          'tts.language': language,
          'tts.voice': voice
        });
        try {
          const {filePath, servedFromCache, rtt} = await synthAudio(stats, {
            text,
            vendor,
            language,
            voice,
            engine,
            model,
            salt,
            credentials
          });
          this.logger.debug(`file ${filePath}, served from cache ${servedFromCache}`);
          if (filePath) cs.trackTmpFile(filePath);
          if (!servedFromCache && !lastUpdated) {
            lastUpdated = true;
            updateSpeechCredentialLastUsed(credentials.speech_credential_sid)
              .catch(() => {/*already logged error */});
          }
          span.setAttributes({'tts.cached': servedFromCache});
          span.end();
          if (!servedFromCache && rtt) {
            this.notifyStatus({
              event: 'synthesized-audio',
              vendor,
              language,
              characters: text.length,
              elapsedTime: rtt
            });
          }
          return filePath;
        } catch (err) {
          this.logger.info({err}, 'Error synthesizing tts');
          span.end();
          writeAlerts({
            account_sid: cs.accountSid,
            alert_type: AlertType.TTS_NOT_PROVISIONED,
            vendor,
            detail: err.message
          }).catch((err) => this.logger.info({err}, 'Error generating alert for tts failure'));
          this.notifyError({msg: 'TTS error', details: err.message || err});
          return;
        }
      };

      const arr = this.text.map((t) => generateAudio(t));
      const filepath = (await Promise.all(arr)).filter((fp) => fp && fp.length);
      this.logger.debug({filepath}, 'synthesized files for tts');
      this.notifyStatus({event: 'start-playback'});

      while (!this.killed && (this.loop === 'forever' || this.loop--) && this.ep?.connected) {
        let segment = 0;
        while (!this.killed && segment < filepath.length) {
          if (cs.isInConference) {
            const {memberId, confName, confUuid} = cs;
            await this.playToConfMember(this.ep, memberId, confName, confUuid, filepath[segment]);
          }
          else {
            this.logger.debug(`Say:exec sending command to play file ${filepath[segment]}`);
            await ep.play(filepath[segment]);
            this.logger.debug(`Say:exec completed play file ${filepath[segment]}`);
          }
          segment++;
        }
      }
    } catch (err) {
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
        this.notifyStatus({event: 'kill-playback'});
        this.ep.api('uuid_break', this.ep.uuid);
      }
    }
  }
}

module.exports = TaskSay;
