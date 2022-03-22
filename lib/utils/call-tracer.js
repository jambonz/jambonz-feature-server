const {context, trace} = require('@opentelemetry/api');

class RootSpan {
  constructor(callType, req) {
    const {tracer} = req.srf.locals.otel;
    const {callSid} = req.locals;

    this._span = tracer.startSpan(callType || 'incoming-call');
    this._span.setAttributes({
      callSid,
      accountSid: req.get('X-Account-Sid'),
      applicationSid: req.locals.application_sid,
      callId: req.get('Call-ID'),
      externalCallId: req.get('X-CID')
    });
    this._ctx = trace.setSpan(context.active(), this._span);
    this.tracer = tracer;
  }

  get context() {
    return this._ctx;
  }

  get traceId() {
    return this._span.spanContext().traceId;
  }

  setAttributes(attrs) {
    this._span.setAttributes(attrs);
  }

  end() {
    this._span.end();
  }

  startChildSpan(name, attributes) {
    const span = this.tracer.startSpan(name, attributes, this._ctx);
    const ctx = trace.setSpan(context.active(), span);
    return {span, ctx};
  }
}

module.exports = RootSpan;

