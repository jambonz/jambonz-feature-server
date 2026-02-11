class Intent {
  constructor(logger, evt) {
    this.logger = logger;
    this.evt = evt;

    this.qr = this.isCX ? evt.detect_intent_response.query_result : evt.query_result;
    this.dtmfRequest = this._checkIntentForDtmfEntry();
  }

  get response_id() {
    return this.isCX ? this.evt.detect_intent_response.response_id : this.evt.response_id;
  }

  get isEmpty() {
    return !(this.response_id?.length > 0);
  }

  get fulfillmentText() {
    if (this.isCX) {
      if (this.qr && this.qr.response_messages) {
        for (const msg of this.qr.response_messages) {
          if (msg.text && msg.text.text && msg.text.text.length > 0) {
            return msg.text.text.join('\n');
          }
          if (msg.output_audio_text) {
            if (msg.output_audio_text.text) return msg.output_audio_text.text;
            if (msg.output_audio_text.ssml) return msg.output_audio_text.ssml;
          }
        }
      }
      return undefined;
    }
    return this.qr.fulfillment_text;
  }

  get saysEndInteraction() {
    if (this.isCX) {
      if (!this.qr || !this.qr.response_messages) return false;
      const end_interaction = this.qr.response_messages
        .find((m) => typeof m === 'object' && 'end_interaction' in m)?.end_interaction;
      return end_interaction && Object.keys(end_interaction).length > 0;
    }
    return this.qr.intent.end_interaction;
  }

  get saysCollectDtmf() {
    return !!this.dtmfRequest;
  }

  get dtmfInstructions() {
    return this.dtmfRequest;
  }

  get name() {
    if (!this.isEmpty) {
      if (this.isCX) {
        return this.qr.match?.intent?.display_name;
      }
      return this.qr.intent.display_name;
    }
  }

  get isCX() {
    return typeof this.evt.detect_intent_response === 'object';
  }

  get isNoInput() {
    if (this.isCX && this.qr && this.qr.match) {
      return this.qr.match.match_type === 'NO_INPUT';
    }
    return false;
  }

  toJSON() {
    return {
      name: this.name,
      fulfillmentText: this.fulfillmentText
    };
  }

  /**
   * Parse a returned intent for DTMF entry information (ES only).
   * CX does not use fulfillment_messages or output_contexts.
   *
   * allow-dtmf-x-y-z
   * x = min number of digits
   * y = optional, max number of digits
   * z = optional, terminating character
   */
  _checkIntentForDtmfEntry() {
    if (this.isCX) return;

    const qr = this.qr;
    if (!qr || !qr.fulfillment_messages || !qr.output_contexts) {
      return;
    }

    // check for custom payloads with a gather verb
    const custom = qr.fulfillment_messages.find((f) => f.payload && f.payload.verb === 'gather');
    if (custom) {
      this.logger.info({custom}, 'found dtmf custom payload');
      return {
        max: custom.payload.numDigits,
        term: custom.payload.finishOnKey,
        template: custom.payload.responseTemplate
      };
    }

    // check for an output context with a specific naming convention
    const context = qr.output_contexts.find((oc) => oc.name.includes('/contexts/allow-dtmf-'));
    if (context) {
      const arr = /allow-dtmf-(\d+)(?:-(\d+))?(?:-(.*))?/.exec(context.name);
      if (arr) {
        this.logger.info('found dtmf output context');
        return {
          min: parseInt(arr[1]),
          max: arr.length > 2 ? parseInt(arr[2]) : null,
          term: arr.length > 3 ? arr[3] : null
        };
      }
    }
  }
}

module.exports = Intent;
