const {TraceFlags, trace, isSpanContextValid, isValidTraceId, isValidSpanId} = require('@opentelemetry/api');
const {isTracingSuppressed} = require('@opentelemetry/core');
const {Dialog} = require('drachtio-srf');

class SipPropagator {
  constructor() {
  }

  inject(context, carrier, setter) {
    const spanContext = trace.getSpanContext(context);
    if (!spanContext || !isSpanContextValid(spanContext) || isTracingSuppressed(context)) {
      return;
    }
    setter.set(carrier, 'traceId', spanContext.traceId);
    setter.set(carrier, 'spanId', spanContext.spanId);
  }

  extract(context, carrier) {
    const callSid = this.getCallSidFromCarrier(carrier);
    const traceId = this.getHexValue(callSid);
    const spanId = traceId.substring(0, 16);
    if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) {
      return context;
    }
    return trace.setSpanContext(context, {
      traceId,
      spanId,
      isRemote: true,
      traceFlags: TraceFlags.SAMPLED
    });
  }

  fields() {
    return ['traceId', 'spanId'];
  }

  getCallSidFromCarrier(carrier) {
    if (carrier instanceof Dialog) {
      return carrier.callSid;
    } else {
      return carrier.locals.callSid;
    }
  }

  getHexValue(callSid) {
    return callSid.replaceAll('-', '');
  }
}

exports.SipPropagator = SipPropagator;
