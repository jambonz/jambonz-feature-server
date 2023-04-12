
const {trace, context, SpanKind, propagation} = require('@opentelemetry/api');
const {Dialog} = require('drachtio-srf');


class RootSpan {
  constructor(callType, req) {
    const tracer = req.srf.locals.otel.tracer;
    const ctx = propagation.extract(context.active(), req);
    this._span = tracer.startSpan(callType || 'incoming-call', {
      kind: SpanKind.CONSUMER,
      attributes: this.getSpanAttributes(req),
      root: false
    }, ctx);
    this._ctx = trace.setSpan(ctx, this._span);
    this.tracer = tracer;
  }

  getSpanAttributes(req) {
    if (req instanceof Dialog) {
      const {sip, callSid, linkedSpanId} = req;
      const {callId} = sip;
      return {
        linkedSpanId,
        callId,
        callSid
      };
    } else {
      const {locals} = req;
      const {callSid} = locals;
      return {
        callSid,
        accountSid: req.get('X-Account-Sid'),
        applicationSid: locals.application_sid,
        callId: req.get('Call-ID'),
        externalCallId: req.get('X-CID')
      };
    }
  }

  get context() {
    return this._ctx;
  }

  get traceId() {
    return this._span.spanContext().traceId;
  }

  get spanId() {
    return this._span.spanContext().spanId;
  }

  get traceFlags() {
    return this._span.spanContext().traceFlags;
  }

  getTracingPropagation(encoding) {
    // TODO: support encodings beyond b3 https://github.com/openzipkin/b3-propagation
    if (this._span && this.traceId !== '00000000000000000000000000000000') {
      return `${this.traceId}-${this.spanId}-1`;
    }
  }

  setAttributes(attrs) {
    this._span.setAttributes(attrs);
  }

  end() {
    if (!this._span.ended) {
      this._span.end();
    }
  }

  startChildSpan(name, attributes) {
    const span = this.tracer.startSpan(name, attributes, this._ctx);
    const ctx = trace.setSpan(this._ctx, span);
    return {span, ctx};
  }
}

module.exports = RootSpan;
