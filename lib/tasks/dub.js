const {TaskName} = require('../utils/constants');
const TtsTask = require('./tts-task');
const assert = require('assert');
const parseDecibels = require('../utils/parse-decibels');

/**
 * Dub task: add or remove additional audio tracks into the call
 */
class TaskDub extends TtsTask {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);

    this.logger.debug({opts: this.data}, 'TaskDub constructor');
    ['action', 'track', 'play', 'say', 'loop'].forEach((prop) => {
      this[prop] = this.data[prop];
    });
    this.gain = parseDecibels(this.data.gain);

    assert.ok(this.action, 'TaskDub: action is required');
    assert.ok(this.track, 'TaskDub: track is required');
  }

  get name() { return TaskName.Dub; }

  async exec(cs, {ep}) {
    super.exec(cs);

    try {
      switch (this.action) {
        case 'addTrack':
          await this._addTrack(cs, ep);
          break;
        case 'removeTrack':
          await this._removeTrack(cs, ep);
          break;
        case 'silenceTrack':
          await this._silenceTrack(cs, ep);
          break;
        case 'playOnTrack':
          await this._playOnTrack(cs, ep);
          break;
        case 'sayOnTrack':
          await this._sayOnTrack(cs, ep);
          break;
        default:
          throw new Error(`TaskDub: unsupported action ${this.action}`);
      }
    } catch (err) {
      this.logger.error(err, 'Error executing dub task');
    }
  }

  async _addTrack(cs, ep) {
    this.logger.info(`adding track: ${this.track}`);
    await ep.dub({
      action: 'addTrack',
      track: this.track
    });

    if (this.play) await this._playOnTrack(cs, ep);
    else if (this.say) await this._sayOnTrack(cs, ep);
  }

  async _removeTrack(_cs, ep) {
    this.logger.info(`removing track: ${this.track}`);
    await ep.dub({
      action: 'removeTrack',
      track: this.track
    });
  }

  async _silenceTrack(_cs, ep) {
    this.logger.info(`silencing track: ${this.track}`);
    await ep.dub({
      action: 'silenceTrack',
      track: this.track
    });
  }

  async _playOnTrack(_cs, ep) {
    this.logger.info(`playing on track: ${this.track}`);
    await ep.dub({
      action: 'playOnTrack',
      track: this.track,
      play: this.play,
      // drachtio-fsmrf will convert loop from boolean to 'loop' or 'once'
      loop: this.loop,
      gain: this.gain
    });
  }

  async _sayOnTrack(cs, ep) {
    const text = this.say.text || this.say;
    this.synthesizer = this.say.synthesizer || {};

    if (Object.keys(this.synthesizer).length) {
      this.logger.info({synthesizer: this.synthesizer},
        `saying on track ${this.track}: ${text} with synthesizer options`);
    }
    else {
      this.logger.info(`saying on track ${this.track}: ${text}`);
    }
    this.synthesizer = this.synthesizer || {};

    this.text = [text];

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

    const disableTtsStreaming = false;
    const filepath = await this._synthesizeWithSpecificVendor(cs, ep, {
      vendor, language, voice, label, disableTtsStreaming
    });
    assert.ok(filepath.length === 1, 'TaskDub: no filepath returned from synthesizer');

    const path = filepath[0];
    if (!path.startsWith('say:{')) {
      /* we have a local file of mp3 or r8 of synthesized speech audio to play */
      this.logger.info(`playing synthesized speech from file on track ${this.track}: ${path}`);
      this.play = path;
      await this._playOnTrack(cs, ep);
    }
    else {
      this.logger.info(`doing actual text to speech file on track ${this.track}: ${path}`);
      await ep.dub({
        action: 'sayOnTrack',
        track: this.track,
        say: path,
        gain: this.gain
      });
    }
  }
}

module.exports = TaskDub;
