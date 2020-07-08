class Intent {
  constructor(logger, evt) {
    this.logger = logger;
    this.evt = evt;

    this.logger.debug({evt}, 'intent');
    this.dtmfRequest = checkIntentForDtmfEntry(logger, evt);
  }

  get isEmpty() {
    return this.evt.response_id.length === 0;
  }

  get fulfillmentText() {
    return this.evt.query_result.fulfillment_text;
  }

  get saysEndInteraction() {
    return this.evt.query_result.intent.end_interaction ;
  }

  get saysCollectDtmf() {
    return !!this.dtmfRequest;
  }

  get dtmfInstructions() {
    return this.dtmfRequest;
  }

  get name() {
    if (!this.isEmpty) return this.evt.query_result.intent.display_name;
  }

  toJSON() {
    return {
      name: this.name,
      fulfillmentText: this.fulfillmentText
    };
  }

}

module.exports = Intent;

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
const checkIntentForDtmfEntry = (logger, intent) => {
  const qr = intent.query_result;
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
};
