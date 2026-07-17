import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';

const MAX_BODY_BYTES = 1_048_576;

export function createHttpHandler({ gateway, nexusWebhookSecret, logger }) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://gateway.local');
    try {
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        const body = await readBody(req);
        const result = await gateway.submit(parseJson(body));
        return sendJson(res, 200, result);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/messages/')) {
        const clientRef = decodeURIComponent(url.pathname.slice('/v1/messages/'.length));
        if (!clientRef) throw new AppError(400, 'INVALID_CLIENT_REF', 'client_ref is required.');
        const message = gateway.store.getMessage(clientRef);
        if (!message) throw new AppError(404, 'NOT_FOUND', 'No message exists for this client_ref.');
        return sendJson(res, 200, message);
      }
      if (req.method === 'POST' && url.pathname === '/webhooks/nexus/status') {
        const rawBody = await readBody(req);
        const signature = req.headers['x-nexus-signature'];
        if (!verifyNexusSignature(rawBody, signature, nexusWebhookSecret)) {
          throw new AppError(401, 'INVALID_SIGNATURE', 'Nexus webhook signature is invalid.');
        }
        const payload = parseJson(rawBody);
        const suppliedEventId = req.headers['x-nexus-event-id'];
        const eventKey = suppliedEventId ? `nexus:${suppliedEventId}` : `nexus:${createHash('sha256').update(rawBody).digest('hex')}`;
        const result = gateway.receiveNexusStatus(payload, eventKey);
        return sendJson(res, 200, { ok: true, duplicate: result.duplicate, ignored: result.ignored || false, message: result.message });
      }
      if (req.method === 'POST' && url.pathname === '/v1/dlr/poll') {
        const results = await gateway.pollOrbit();
        return sendJson(res, 200, { polled: results.length, results });
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { ok: true });
      }
      throw new AppError(404, 'NOT_FOUND', 'Route not found.');
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
      if (!(error instanceof AppError)) logger?.error('http_unhandled_error', { error: error?.message });
      return sendJson(res, appError.status, { error: { code: appError.code, message: appError.message, ...(appError.details ? { details: appError.details } : {}) } });
    }
  };
}

export function signNexusPayload(payload, secret) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function verifyNexusSignature(rawBody, supplied, secret) {
  if (typeof supplied !== 'string' || !secret) return false;
  const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
  const expected = Buffer.from(`sha256=${digest}`);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 1 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseJson(buffer) {
  if (buffer.length === 0) throw new AppError(400, 'INVALID_BODY', 'Request body must not be empty.');
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Request body must contain valid JSON.');
  }
}

function sendJson(res, status, body) {
  const output = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(output) });
  res.end(output);
}
