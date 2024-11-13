const opentelemetry = require('@opentelemetry/api');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const { ZipkinExporter } = require('@opentelemetry/exporter-zipkin');
const  { OTLPTraceExporter } = require ('@opentelemetry/exporter-trace-otlp-http');
const {
  JAMBONES_OTEL_ENABLED,
  OTEL_EXPORTER_JAEGER_AGENT_HOST,
  OTEL_EXPORTER_JAEGER_ENDPOINT,
  OTEL_EXPORTER_ZIPKIN_URL,
  OTEL_EXPORTER_COLLECTOR_URL
} = require('./lib/config');

module.exports = (serviceName) => {
  if (JAMBONES_OTEL_ENABLED) {
    const {version} = require('./package.json');
    const provider = new NodeTracerProvider({
      resource: new Resource({
        [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
        [SemanticResourceAttributes.SERVICE_VERSION]: version,
      }),
    });

    const exporters = [];

    if (OTEL_EXPORTER_JAEGER_AGENT_HOST  || OTEL_EXPORTER_JAEGER_ENDPOINT) {
      exporters.push(new JaegerExporter());
    }

    if (OTEL_EXPORTER_ZIPKIN_URL) {
      exporters.push(new ZipkinExporter({url:OTEL_EXPORTER_ZIPKIN_URL}));
    }

    if (OTEL_EXPORTER_ZIPKIN_URL) {
      exporters.push(new ZipkinExporter({url:OTEL_EXPORTER_ZIPKIN_URL}));
    }

    if (OTEL_EXPORTER_COLLECTOR_URL) {
      exporters.push(new OTLPTraceExporter({
        url: OTEL_EXPORTER_COLLECTOR_URL
      }));
    }

    exporters.forEach((element) => {
      provider.addSpanProcessor(new BatchSpanProcessor(element, {
        // The maximum queue size. After the size is reached spans are dropped.
        maxQueueSize: 100,
        // The maximum batch size of every export. It must be smaller or equal to maxQueueSize.
        maxExportBatchSize: 10,
        // The interval between two consecutive exports
        scheduledDelayMillis: 500,
        // How long the export can run before it is cancelled
        exportTimeoutMillis: 30000,
      }));
    });

    // Initialize the OpenTelemetry APIs to use the NodeTracerProvider bindings
    provider.register();
    registerInstrumentations({
      instrumentations: [
        //new HttpInstrumentation(),
        //new ExpressInstrumentation(),
        //new PinoInstrumentation()
      ],
    });
  }

  return opentelemetry.trace.getTracer(serviceName);
};

