import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local mock of the /v1 API for tests. It answers every operation in an OpenAPI document
 * with the example of its first 2xx response, checks the bearer key format, and records each
 * request. Tests can queue one-off responses (e.g. a 429 before a 200). It listens on
 * 127.0.0.1 only and never calls a real API.
 */

export const FIXTURE_SPEC_PATH = new URL('../../test/fixtures/openapi.json', import.meta.url);

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: unknown;
}

export interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface Operation {
  method: string;
  pattern: RegExp;
  response: MockResponse;
}

interface Spec {
  paths: Record<
    string,
    Record<
      string,
      { responses?: Record<string, { content?: Record<string, { example?: unknown }> }> }
    >
  >;
}

export function loadSpec(path: URL = FIXTURE_SPEC_PATH): Spec {
  return JSON.parse(readFileSync(path, 'utf8')) as Spec;
}

function compileOperations(spec: Spec): Operation[] {
  const ops: Operation[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    const pattern = new RegExp(
      '^' +
        path
          .split('/')
          .map((seg) => (/^\{.+\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^$()|[\]\\]/g, '\\$&')))
          .join('/') +
        '$',
    );
    for (const [method, op] of Object.entries(item)) {
      const [status, res] = Object.entries(op.responses ?? {}).find(([s]) => /^2\d\d$/.test(s)) ?? [
        '200',
        undefined,
      ];
      ops.push({
        method: method.toUpperCase(),
        pattern,
        response: { status: Number(status), body: res?.content?.['application/json']?.example },
      });
    }
  }
  return ops;
}

export interface MockApi {
  url: string;
  requests: RecordedRequest[];
  /** Queues a response for the next request matching method and path (exact path). */
  enqueue(method: string, path: string, response: MockResponse): void;
  close(): Promise<void>;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function startMockApi(spec: Spec = loadSpec()): Promise<MockApi> {
  const operations = compileOperations(spec);
  const queued = new Map<string, MockResponse[]>();
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = req.method ?? 'GET';
      requests.push({
        method,
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body: await readJson(req),
      });

      const send = (r: MockResponse): void => {
        res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
        res.end(r.body === undefined ? '' : JSON.stringify(r.body));
      };

      const auth = req.headers.authorization ?? '';
      if (!/^Bearer iv_(test|live)_[A-Za-z0-9_-]+$/.test(auth)) {
        send({
          status: 401,
          body: { error: { code: 'unauthorized', message: 'Missing or invalid API key.' } },
        });
        return;
      }
      const queue = queued.get(`${method} ${url.pathname}`);
      const next = queue?.shift();
      if (next) {
        send(next);
        return;
      }
      const op = operations.find((o) => o.method === method && o.pattern.test(url.pathname));
      send(
        op
          ? op.response
          : { status: 404, body: { error: { code: 'not_found', message: 'No such route.' } } },
      );
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    enqueue(method, path, response) {
      const k = `${method.toUpperCase()} ${path}`;
      queued.set(k, [...(queued.get(k) ?? []), response]);
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
