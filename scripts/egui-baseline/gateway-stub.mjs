import http from "node:http";
import { performance } from "node:perf_hooks";

export const GATEWAY_STUB_PROTOCOL = Object.freeze({
  schemaVersion: 1,
  host: "127.0.0.1",
  nonStreamRequestsPerPhase: 24,
  nonStreamConcurrency: 4,
  streamRequestsPerPhase: 4,
  streamDataEvents: 5,
  streamEventIntervalMs: 20,
});

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function validateGatewayStubEvidence(value, phaseCount = 2) {
  if (!isObject(value) || !isObject(value.protocol) || !isObject(value.counters)) {
    throw new Error("gateway stub evidence must contain protocol and counters");
  }
  for (const [name, expected] of Object.entries(GATEWAY_STUB_PROTOCOL)) {
    if (!Object.is(value.protocol[name], expected)) {
      throw new Error(`gateway stub protocol mismatch: ${name}`);
    }
  }
  const expectedNonStreamRequests = phaseCount * GATEWAY_STUB_PROTOCOL.nonStreamRequestsPerPhase;
  const expectedStreamRequests = phaseCount * GATEWAY_STUB_PROTOCOL.streamRequestsPerPhase;
  const expectedRequests = expectedNonStreamRequests + expectedStreamRequests;
  const expectedCounters = {
    requests: expectedRequests,
    authenticatedRequests: expectedRequests,
    nonStreamRequests: expectedNonStreamRequests,
    streamRequests: expectedStreamRequests,
    rejectedRequests: 0,
  };
  for (const [name, expected] of Object.entries(expectedCounters)) {
    if (value.counters[name] !== expected) {
      throw new Error(`gateway stub ${name} mismatch: expected ${expected}`);
    }
  }
  if (
    !Array.isArray(value.counters.streamSchedules) ||
    value.counters.streamSchedules.length !== expectedStreamRequests
  ) {
    throw new Error(`gateway stub must contain ${expectedStreamRequests} stream schedules`);
  }
  const schedulesByRequest = new Map();
  for (const schedule of value.counters.streamSchedules) {
    if (
      !isObject(schedule) ||
      !Number.isSafeInteger(schedule.requestIndex) ||
      schedule.requestIndex < 1 ||
      schedule.requestIndex > expectedStreamRequests ||
      schedulesByRequest.has(schedule.requestIndex)
    ) {
      throw new Error("gateway stub stream schedule request identity is invalid");
    }
    schedulesByRequest.set(schedule.requestIndex, schedule);
    const offsets = schedule.eventWriteOffsetsMs;
    const deviations = schedule.intervalDeviationsMs;
    if (
      !Array.isArray(offsets) ||
      offsets.length !== GATEWAY_STUB_PROTOCOL.streamDataEvents + 1 ||
      offsets[0] !== 0 ||
      !offsets.every(
        (offset, index) =>
          Number.isFinite(offset) && offset >= 0 && (index === 0 || offset > offsets[index - 1])
      ) ||
      !Array.isArray(deviations) ||
      deviations.length !== offsets.length - 1 ||
      !deviations.every(Number.isFinite)
    ) {
      throw new Error(`gateway stub stream schedule ${schedule.requestIndex} is invalid`);
    }
    for (let index = 0; index < deviations.length; index += 1) {
      const expectedDeviation =
        offsets[index + 1] - offsets[index] - GATEWAY_STUB_PROTOCOL.streamEventIntervalMs;
      if (Math.abs(deviations[index] - expectedDeviation) > 1e-6) {
        throw new Error(`gateway stub stream schedule ${schedule.requestIndex} drift mismatch`);
      }
    }
  }
  return value;
}

const JSON_BODY = JSON.stringify({
  id: "chatcmpl-egui-baseline",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "benchmark-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "fixed benchmark response" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 4, completion_tokens: 4, total_tokens: 8 },
});

const EXPECTED_AUTHORIZATION = "Bearer sk-aio-benchmark-local-only";

function streamEvent(index) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-egui-baseline",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "benchmark-model",
    choices: [
      {
        index: 0,
        delta: { content: String(index) },
        finish_reason: null,
      },
    ],
  })}\n\n`;
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startGatewayStub() {
  const counters = {
    requests: 0,
    authenticatedRequests: 0,
    nonStreamRequests: 0,
    streamRequests: 0,
    rejectedRequests: 0,
  };
  const streamSchedules = [];

  const server = http.createServer(async (request, response) => {
    counters.requests += 1;
    try {
      if (request.method !== "POST" || request.url?.split("?", 1)[0] !== "/v1/chat/completions") {
        counters.rejectedRequests += 1;
        response.writeHead(404, { "content-type": "application/json", connection: "close" });
        response.end('{"error":"unsupported benchmark request"}');
        return;
      }
      if (request.headers.authorization !== EXPECTED_AUTHORIZATION) {
        counters.rejectedRequests += 1;
        response.writeHead(401, { "content-type": "application/json", connection: "close" });
        response.end('{"error":"benchmark authorization was not injected"}');
        return;
      }
      counters.authenticatedRequests += 1;
      const body = await readJsonBody(request);
      if (body?.model !== "benchmark-model" || !Array.isArray(body.messages)) {
        counters.rejectedRequests += 1;
        response.writeHead(400, { "content-type": "application/json", connection: "close" });
        response.end('{"error":"invalid benchmark request"}');
        return;
      }

      if (body.stream === true) {
        counters.streamRequests += 1;
        const requestIndex = counters.streamRequests;
        const eventWriteTimes = [];
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          "x-aio-benchmark-stub": "1",
        });
        response.flushHeaders();
        for (let index = 0; index < GATEWAY_STUB_PROTOCOL.streamDataEvents; index += 1) {
          eventWriteTimes.push(performance.now());
          response.write(streamEvent(index));
          await new Promise((resolve) =>
            setTimeout(resolve, GATEWAY_STUB_PROTOCOL.streamEventIntervalMs)
          );
        }
        eventWriteTimes.push(performance.now());
        response.end("data: [DONE]\n\n");
        const firstWrite = eventWriteTimes[0];
        const eventWriteOffsetsMs = eventWriteTimes.map((timestamp) => timestamp - firstWrite);
        streamSchedules.push({
          requestIndex,
          eventWriteOffsetsMs,
          intervalDeviationsMs: eventWriteOffsetsMs
            .slice(1)
            .map(
              (offset, index) =>
                offset - eventWriteOffsetsMs[index] - GATEWAY_STUB_PROTOCOL.streamEventIntervalMs
            ),
        });
        return;
      }

      counters.nonStreamRequests += 1;
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(JSON_BODY),
        "x-aio-benchmark-stub": "1",
      });
      response.end(JSON_BODY);
    } catch {
      counters.rejectedRequests += 1;
      if (!response.headersSent) {
        response.writeHead(400, { "content-type": "application/json", connection: "close" });
      }
      response.end('{"error":"invalid benchmark request"}');
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, GATEWAY_STUB_PROTOCOL.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address == null || typeof address === "string") {
    server.close();
    throw new Error("gateway stub did not expose a TCP address");
  }

  let closed = false;
  return {
    url: `http://${GATEWAY_STUB_PROTOCOL.host}:${address.port}`,
    protocol: GATEWAY_STUB_PROTOCOL,
    snapshot: () => ({
      ...counters,
      streamSchedules: streamSchedules.map((schedule) => ({
        ...schedule,
        eventWriteOffsetsMs: [...schedule.eventWriteOffsetsMs],
        intervalDeviationsMs: [...schedule.intervalDeviationsMs],
      })),
    }),
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeIdleConnections?.();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
