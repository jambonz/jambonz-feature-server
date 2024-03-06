const {TaskName} = require('../utils/constants');
const TtsTask = require('./tts-task');
const assert = require('assert');

/**
 * Dub task: add or remove additional audio tracks into the call
 */
class TaskDub extends TtsTask {
  constructor(logger, opts, parentTask) {
    super(logger, opts, parentTask);

    ['action', 'track', 'play', 'say', 'loop', 'synthesizer'].forEach((prop) => {
      this[prop] = this.data[prop];
    });
    this.gain = this._parseDecibels(this.data.gain);

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
    await ep.api('uuid_dub', [ep.uuid, 'addTrack', this.track]);

    /* if play was specified now kick that off */
    if (this.play) await this._playOnTrack(cs, ep);
    else if (this.say) await this._sayOnTrack(cs, ep);
  }
  async _removeTrack(_cs, ep) {
    this.logger.info(`removing track: ${this.track}`);
    await ep.api('uuid_dub', [ep.uuid, 'removeTrack', this.track]);
  }
  async _silenceTrack(_cs, ep) {
    this.logger.info(`silencing track: ${this.track}`);
    await ep.api('uuid_dub', [ep.uuid, 'silenceTrack', this.track]);
  }
  async _playOnTrack(_cs, ep) {
    this.logger.info(`playing on track: ${this.track}`);
    const args = [ep.uuid, 'playOnTrack', this.track, this.play];
    if (this.loop) args.push('loop');
    if (this.gain) args.push(this.gain);
    await ep.api('uuid_dub', args);
  }
  async _sayOnTrack(cs, ep) {
    this.logger.info(`saying on track ${this.track}: ${this.say}`);
    this.synthesizer = this.synthesizer || {};
    this.text = [this.say];

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

    const filepath = await this._synthesizeWithSpecificVendor(cs, ep, {vendor, language, voice, label});
    assert.ok(filepath.length === 1, 'TaskDub: no filepath returned from synthesizer');

    const path = filepath[0];
    if (!path.startsWith('say:{')) {
      /* we have a local file of mp3 or r8 of synthesized speech audio to play */
      this.play = path;
      await this._playOnTrack(ep);
    }
    else {
      const arr = /^say:\{.*\}\s*(.*)$/.exec(path);
      if (arr) this.logger.debug(`TaskDub:sayOnTrack sending streaming tts request: ${arr[1].substring(0, 64)}..`);
      const args = [ep.uuid, 'sayOnTrack', this.track, path];
      if (this.loop) args.push('loop');
      if (this.gain) args.push(this.gain);
      await ep.api('uuid_dub', args);
    }
  }

  _parseDecibels(db) {
    if (typeof db === 'number') {
      return db;
    }
    else if (typeof db === 'string') {
      const match = db.match(/([+-]?\d+(\.\d+)?)\s*db/i);
      if (match) {
        return Math.trunc(parseFloat(match[1]));
      } else {
        this.logger.info(`invalid gain value will be ignored: ${db}`);
        return 0;
      }
    } else {
      this.logger.info(`invalid gain value will be ignored: ${db}`);
      return 0;
    }
  }
}

module.exports = TaskDub;
