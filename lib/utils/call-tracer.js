const {context, trace} = require('@opentelemetry/api');
const {Dialog} = require('drachtio-srf');
class RootSpan {
  constructor(callType, req) {
    const {srf} = require('../../');
    const tracer = srf.locals.otel.tracer;
    let callSid, accountSid, applicationSid, linkedSpanId;

    if (req instanceof Dialog) {
      const dlg = req;
      callSid = dlg.callSid;
      linkedSpanId = dlg.linkedSpanId;
    }
    else if (req.srf) {
      callSid = req.locals.callSid;
      accountSid = req.get('X-Account-Sid'),
      applicationSid = req.locals.application_sid;
    }
    else {
      callSid = req.callSid;
      accountSid = req.accountSid;
      applicationSid = req.applicationSid;
    }
    this._span = tracer.startSpan(callType || 'incoming-call');
    if (req instanceof Dialog) {
      const dlg = req;
      this._span.setAttributes({
        linkedSpanId,
        callId: dlg.sip.callId
      });
    }
    else if (req.srf) {
      this._span.setAttributes({
        callSid,
        accountSid,
        applicationSid,
        callId: req.get('Call-ID'),
        externalCallId: req.get('X-CID')
      });
    }
    else {
      this._span.setAttributes({
        callSid,
        accountSid,
        applicationSid
      });
    }

    this._ctx = trace.setSpan(context.active(), this._span);
    this.tracer = tracer;
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

