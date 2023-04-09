const {context, trace} = require('@opentelemetry/api');
const {Dialog} = require('drachtio-srf');
const {uuid} = require('uuid');

class RootSpan {
  constructor(callType, req) {
    let tracer, callSid, linkedSpanId;

    if (req instanceof Dialog) {
      const dlg = req;
      tracer = dlg.srf.locals.otel.tracer;
      callSid = dlg.callSid;
      linkedSpanId = dlg.linkedSpanId;
    }
    else {
      tracer = req.srf.locals.otel.tracer;
      callSid = req.locals.callSid;
    }
    this._span = tracer.startSpan(callType || 'incoming-call');
    this._span._spanContext.traceId = this.getHexValue(callSid);

    if (req instanceof Dialog) {
      const dlg = req;
      this._span.setAttributes({
        linkedSpanId,
        callId: dlg.sip.callId
      });
    }
    else {
      this._span.setAttributes({
        callSid,
        accountSid: req.get('X-Account-Sid'),
        applicationSid: req.locals.application_sid,
        callId: req.get('Call-ID'),
        externalCallId: req.get('X-CID')
      });
    }

    this._ctx = trace.setSpan(context.active(), this._span);
    this.tracer = tracer;
  }

  getHexValue(callSid) {
    const callSidBytes = uuid.parse(callSid);
    return new Buffer(callSidBytes).toString('hex');
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
    if (this._span  && this.traceId !== '00000000000000000000000000000000') {
      return `${this.traceId}-${this.spanId}-1`;
    }
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

