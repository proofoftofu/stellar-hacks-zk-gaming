import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

function assertCond(condition, message) {
  if (!condition) throw new Error(message);
}

function isObject(value) {
  return typeof value === 'object' && value !== null;
}

function toJsonBody(req) {
  const raw = req.body;
  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw);
    assertCond(isObject(parsed), 'JSON body must be an object');
    return parsed;
  }
  assertCond(isObject(raw), 'JSON body must be an object');
  return raw;
}

function asNumberArray(name, value, len, min, max) {
  assertCond(Array.isArray(value), `${name} must be an array`);
  assertCond(value.length === len, `${name} must have length ${len}`);
  for (const item of value) {
    assertCond(Number.isInteger(item) && Number(item) >= min && Number(item) <= max, `${name} contains invalid value ${String(item)}`);
  }
  return value;
}

export function normalizeCommitmentBody(body) {
  const secret = asNumberArray('secret', body.secret, 4, 1, 6);
  const salt = asNumberArray('salt', body.salt, 16, 0, 255);
  return { secret, salt };
}

export function normalizeProveBody(body) {
  const parsed = {
    session_id: Number(body.session_id),
    guess_id: Number(body.guess_id),
    commitment: String(body.commitment),
    guess: asNumberArray('guess', body.guess, 4, 1, 6),
    exact: Number(body.exact),
    partial: Number(body.partial),
    secret: asNumberArray('secret', body.secret, 4, 1, 6),
    salt: asNumberArray('salt', body.salt, 16, 0, 255),
  };
  assertCond(Number.isInteger(parsed.session_id) && parsed.session_id >= 0, 'session_id must be non-negative integer');
  assertCond(Number.isInteger(parsed.guess_id) && parsed.guess_id >= 0, 'guess_id must be non-negative integer');
  assertCond(/^\d+$/.test(parsed.commitment), 'commitment must be decimal string');
  assertCond(Number.isInteger(parsed.exact) && parsed.exact >= 0 && parsed.exact <= 4, 'exact must be 0..4');
  assertCond(Number.isInteger(parsed.partial) && parsed.partial >= 0 && parsed.partial <= 4, 'partial must be 0..4');
  assertCond(parsed.exact + parsed.partial <= 4, 'exact + partial must be <= 4');
  return parsed;
}

export function json(res, status, payload) {
  res.status(status).json(payload);
}

export function allowCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

export function methodNotAllowed(res) {
  json(res, 405, { error: 'method_not_allowed' });
}

export function parseRequestBody(req) {
  return toJsonBody(req);
}

export function computeCommitment(secret, salt) {
  const preimage = Buffer.from([...secret, ...salt]);
  const digest = createHash('blake2s256').update(preimage).digest();
  let value = 0n;
  for (let i = 0; i < 31; i++) {
    value = (value << 8n) + BigInt(digest[i]);
  }
  return value.toString();
}
