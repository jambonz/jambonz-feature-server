class Intent {
  constructor(logger, evt) {
    this.logger = logger;
    this.evt = evt;

    this.logger.debug({evt}, 'intent');
    this.qr = this.isCX ? evt.detect_intent_response.query_result : evt.query_result;
    this.dtmfRequest = this._checkIntentForDtmfEntry(logger, evt);
  }

  get response_id() {
    return this.isCX ? this.evt.detect_intent_response.response_id : this.evt.response_id;
  }

  get isEmpty() {
    return !(this.response_id?.length > 0);
  }

  get fulfillmentText() {
    return this.qr.fulfillment_text;
  }

  get saysEndInteraction() {
    if (this.isCX) {
      const end_interaction = this.qr.response_messages
        .find((m) => typeof m === 'object' && 'end_interaction' in m)?.end_interaction;

      //TODO: need to do more checking on the actual contents
      return end_interaction && Object.keys(end_interaction).length > 0;
    }
    else return this.qr.intent.end_interaction ;
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
      else {
        return this.qr.intent.display_name;
      }
    }
  }

  get isCX() {
    return typeof this.evt.detect_intent_response === 'object';
  }

  get isES() {
    return !this.isCX;
  }

  toJSON() {
    return {
      name: this.name,
      fulfillmentText: this.fulfillmentText
    };
  }

  /**
 * Parse a returned intent for DTMF entry information
 * i.e.
 * allow-dtmf-x-y-z
 * x = min number of digits
 * y = optional, max number of digits
 * z = optional, terminating character
 * e.g.
 * allow-dtmf-5 :     collect 5 digits
 * allow-dtmf-1-4 :   collect between 1 to 4 (inclusive) digits
 * allow-dtmf-1-4-# : collect 1-4 digits, terminating if '#' is entered
 * @param {*} intent - dialogflow intent
 */
  _checkIntentForDtmfEntry(logger, intent) {
    const qr = this.isCX ? intent.detect_intent_response.query_result : intent.query_result;

    if (!qr || !qr.fulfillment_messages || !qr.output_contexts) {
      logger.info({f: qr.fulfillment_messages, o: qr.output_contexts}, 'no dtmfs');
      return;
    }

    // check for custom payloads with a gather verb
    const custom = qr.fulfillment_messages.find((f) => f.payload && f.payload.verb === 'gather');
    if (custom && custom.payload && custom.payload.verb === 'gather') {
      logger.info({custom}, 'found dtmf custom payload');
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
        logger.info({custom}, 'found dtmf output context');
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
