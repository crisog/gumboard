import { registerOTel } from "@vercel/otel";
import { TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { PrismaInstrumentation } from '@prisma/instrumentation'

export function register() {
  registerOTel({
    serviceName: "gumboard",
    instrumentations: [
      new PrismaInstrumentation()
    ],

    traceSampler:
      process.env.NODE_ENV === "production" ? new TraceIdRatioBasedSampler(0.1) : "always_on",

    instrumentationConfig: {
      fetch: {
        // Don't trace internal Next.js calls
        ignoreUrls: [/_next\/static/, /_next\/image/, /favicon\.ico/],

        propagateContextUrls: [/hooks\.slack\.com/],
        resourceNameTemplate: "webhook {http.method} {http.host}",
      },
    },

    attributes: {
      "service.namespace": "antiwork",
      "service.version": process.env.npm_package_version,
      "deployment.environment": process.env.NODE_ENV,
    },
  });
}
