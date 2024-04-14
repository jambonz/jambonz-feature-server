const TtsTask = require('./tts-task');
const {TaskName, TaskPreconditions} = require('../utils/constants');
const pollySSMLSplit = require('polly-ssml-split');

const breakLengthyTextIfNeeded = (logger,  text) => {
  const chunkSize = 1000;
  const isSSML = text.startsWith('<speak>');
  if (text.length <= chunkSize || !isSSML) return [text];
  const options = {
    // MIN length
    softLimit: 100,
    // MAX length, exclude 15 characters <speak></speak>
    hardLimit: chunkSize - 15,
    // Set of extra split characters (Optional property)
    extraSplitChars: ',;!?',
  };
  pollySSMLSplit.configure(options);
  try {
    return pollySSMLSplit.split(text);
  } catch (err) {
    logger.info({err}, 'Error spliting SSML long text');
    return [text];
  }
};

const parseTextFromSayString = (text) => {
  const closingBraceIndex = text.indexOf('}');
  if (closingBraceIndex === -1) return text;
  return text.slice(closingBraceIndex + 1);
};

class TaskSay extends TtsTask {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);
    this.preconditions = TaskPreconditions.Endpoint;

    this.text = (Array.isArray(this.data.text) ? this.data.text : [this.data.text])
      .map((t) => breakLengthyTextIfNeeded(this.logger, t))
      .flat();

    this.loop = this.data.loop || 1;
    this.isHandledByPrimaryProvider = true;
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
    const {srf, accountSid:account_sid} = cs;
    const {writeAlerts, AlertType} = srf.locals;
    const {addFileToCache} = srf.locals.dbHelpers;
    const engine = this.synthesizer.engine || 'standard';

    await super.exec(cs);
    this.ep = ep;

    const vendor = this.synthesizer.vendor && this.synthesizer.vendor !== 'default' ?
      this.synthesizer.vendor :
      cs.speechSynthesisVendor;
    const language = this.synthesizer.language && this.synthesizer.language !== 'default' ?
      this.synthesizer.language :
      cs.speechSynthesisLanguage ;
    const voice =  this.synthesizer.voice && this.synthesizer.voice !== 'default' ?
      this.synthesizer.voice :
      cs.speechSynthesisVoice;
    const label = this.synthesizer.label && this.synthesizer.label !== 'default' ?
      this.synthesizer.label :
      cs.speechSynthesisLabel;

    const fallbackVendor = this.synthesizer.fallbackVendor && this.synthesizer.fallbackVendor !== 'default' ?
      this.synthesizer.fallbackVendor :
      cs.fallbackSpeechSynthesisVendor;
    const fallbackLanguage = this.synthesizer.fallbackLanguage && this.synthesizer.fallbackLanguage !== 'default' ?
      this.synthesizer.fallbackLanguage :
      cs.fallbackSpeechSynthesisLanguage ;
    const fallbackVoice =  this.synthesizer.fallbackVoice && this.synthesizer.fallbackVoice !== 'default' ?
      this.synthesizer.fallbackVoice :
      cs.fallbackSpeechSynthesisVoice;
    const fallbackLabel = this.synthesizer.fallbackLabel && this.synthesizer.fallbackLabel !== 'default' ?
      this.synthesizer.fallbackLabel :
      cs.fallbackSpeechSynthesisLabel;

    let filepath;
    try {
      filepath = await this._synthesizeWithSpecificVendor(cs, ep, {vendor, language, voice, label});
    } catch (error) {
      if (fallbackVendor && this.isHandledByPrimaryProvider) {
        this.isHandledByPrimaryProvider = false;
        this.logger.info(`Synthesize error, fallback to ${fallbackVendor}`);
        filepath = await this._synthesizeWithSpecificVendor(cs, ep,
          {
            vendor: fallbackVendor,
            language: fallbackLanguage,
            voice: fallbackVoice,
            label: fallbackLabel
          });
      } else {
        throw error;
      }
    }
    this.notifyStatus({event: 'start-playback'});

    while (!this.killed && (this.loop === 'forever' || this.loop--) && ep?.connected) {
      let segment = 0;
      while (!this.killed && segment < filepath.length) {
        if (cs.isInConference) {
          const {memberId, confName, confUuid} = cs;
          await this.playToConfMember(ep, memberId, confName, confUuid, filepath[segment]);
        }
        else {
          if (filepath[segment].startsWith('say:{')) {
            const arr = /^say:\{.*\}\s*(.*)$/.exec(filepath[segment]);
            if (arr) this.logger.debug(`Say:exec sending streaming tts request: ${arr[1].substring(0, 64)}..`);
          }
          else this.logger.debug(`Say:exec sending  ${filepath[segment].substring(0, 64)}`);
          ep.once('playback-start', (evt) => {
            this.logger.debug({evt}, 'got playback-start');
            if (this.otelSpan) {
              this._addStreamingTtsAttributes(this.otelSpan, evt);
              this.otelSpan.end();
              this.otelSpan = null;
              if (evt.variable_tts_cache_filename) cs.trackTmpFile(evt.variable_tts_cache_filename);
            }
          });
          ep.once('playback-stop', (evt) => {
            this.logger.debug({evt}, 'got playback-stop');
            if (evt.variable_tts_error) {
              writeAlerts({
                account_sid,
                alert_type: AlertType.TTS_FAILURE,
                vendor,
                detail: evt.variable_tts_error
              }).catch((err) => this.logger.info({err}, 'Error generating alert for no tts'));
            }
            if (evt.variable_tts_cache_filename) {
              const text = parseTextFromSayString(this.text[segment]);
              addFileToCache(evt.variable_tts_cache_filename, {
                account_sid,
                vendor,
                language,
                voice,
                engine,
                text
              }).catch((err) => this.logger.info({err}, 'Error adding file to cache'));
            }
          });
          await ep.play(filepath[segment]);
          if (filepath[segment].startsWith('say:{')) {
            const arr = /^say:\{.*\}\s*(.*)$/.exec(filepath[segment]);
            if (arr) this.logger.debug(`Say:exec complete playing streaming tts request: ${arr[1].substring(0, 64)}..`);
          }
          this.logger.debug(`Say:exec completed play file ${filepath[segment]}`);
        }
        segment++;
      }
    }
    this.emit('playDone');
  }

  async kill(cs) {
    super.kill(cs);
    if (this.ep?.connected) {
      this.logger.debug('TaskSay:kill - killing audio');
      if (cs.isInConference) {
        const {memberId, confName} = cs;
        this.killPlayToConfMember(this.ep, memberId, confName);
      }
      else {
        this.notifyStatus({event: 'kill-playback'});
        this.ep.api('uuid_break', this.ep.uuid);
      }
      this.ep.removeAllListeners('playback-start');
      this.ep.removeAllListeners('playback-stop');
    }
  }

  _addStreamingTtsAttributes(span, evt) {
    const attrs = {'tts.cached': false};
    for (const [key, value] of Object.entries(evt)) {
      if (key.startsWith('variable_tts_')) {
        let newKey = key.substring('variable_tts_'.length)
          .replace('whisper_', 'whisper.')
          .replace('deepgram_', 'deepgram.')
          .replace('elevenlabs_', 'elevenlabs.');
        if (spanMapping[newKey]) newKey = spanMapping[newKey];
        attrs[newKey] = value;
      }
    }
    delete attrs['cache_filename']; //no value in adding this to the span
    span.setAttributes(attrs);
  }
}

const spanMapping = {
  // Elevenlabs
  'elevenlabs.reported_latency_ms': 'elevenlabs.latency_ms',
  'elevenlabs.request_id': 'elevenlabs.req_id',
  'elevenlabs.history_item_id': 'elevenlabs.item_id',
  'elevenlabs.optimize_streaming_latency': 'elevenlabs.optimization',
  'elevenlabs.name_lookup_time_ms': 'name_lookup_ms',
  'elevenlabs.connect_time_ms': 'connect_ms',
  'elevenlabs.final_response_time_ms': 'final_response_ms',
  // Whisper
  'whisper.reported_latency_ms': 'whisper.latency_ms',
  'whisper.request_id': 'whisper.req_id',
  'whisper.reported_organization': 'whisper.organization',
  'whisper.reported_ratelimit_requests': 'whisper.ratelimit_requests',
  'whisper.reported_ratelimit_remaining_requests': 'whisper.ratelimit_remaining_requests',
  'whisper.reported_ratelimit_reset_requests': 'whisper.ratelimit_reset_requests',
  'whisper.name_lookup_time_ms': 'name_lookup_ms',
  'whisper.connect_time_ms': 'connect_ms',
  'whisper.final_response_time_ms': 'final_response_ms',
  // Deepgram
  'deepgram.request_id': 'deepgram.req_id',
  'deepgram.reported_model_name': 'deepgram.model_name',
  'deepgram.reported_model_uuid': 'deepgram.model_uuid',
  'deepgram.reported_char_count': 'deepgram.char_count',
  'deepgram.name_lookup_time_ms': 'name_lookup_ms',
  'deepgram.connect_time_ms': 'connect_ms',
  'deepgram.final_response_time_ms': 'final_response_ms',

};

module.exports = TaskSay;
