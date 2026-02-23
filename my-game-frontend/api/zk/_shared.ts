import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';

export type Guess4 = [number, number, number, number];
export type Salt16 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
];

export type ProveRequest = {
  session_id: number;
  guess_id: number;
  commitment: string;
  guess: Guess4;
  exact: number;
  partial: number;
  secret: Guess4;
  salt: Salt16;
};

type ApiReq = {
  method?: string;
  body?: unknown;
};

type ApiRes = {
  status: (code: number) => ApiRes;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

function assertCond(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toJsonBody(req: ApiReq): Record<string, unknown> {
  const raw = req.body;
  if (typeof raw === 'string') {
    const parsed = JSON.parse(raw) as unknown;
    assertCond(isObject(parsed), 'JSON body must be an object');
    return parsed;
  }
  assertCond(isObject(raw), 'JSON body must be an object');
  return raw;
}

function asNumberArray(name: string, value: unknown, len: number, min: number, max: number): number[] {
  assertCond(Array.isArray(value), `${name} must be an array`);
  assertCond(value.length === len, `${name} must have length ${len}`);
  for (const item of value) {
    assertCond(Number.isInteger(item) && Number(item) >= min && Number(item) <= max, `${name} contains invalid value ${String(item)}`);
  }
  return value as number[];
}

export function normalizeCommitmentBody(body: Record<string, unknown>): { secret: Guess4; salt: Salt16 } {
  const secret = asNumberArray('secret', body.secret, 4, 1, 6) as Guess4;
  const salt = asNumberArray('salt', body.salt, 16, 0, 255) as Salt16;
  return { secret, salt };
}

export function normalizeProveBody(body: Record<string, unknown>): ProveRequest {
  const parsed: ProveRequest = {
    session_id: Number(body.session_id),
    guess_id: Number(body.guess_id),
    commitment: String(body.commitment),
    guess: asNumberArray('guess', body.guess, 4, 1, 6) as Guess4,
    exact: Number(body.exact),
    partial: Number(body.partial),
    secret: asNumberArray('secret', body.secret, 4, 1, 6) as Guess4,
    salt: asNumberArray('salt', body.salt, 16, 0, 255) as Salt16,
  };
  assertCond(Number.isInteger(parsed.session_id) && parsed.session_id >= 0, 'session_id must be non-negative integer');
  assertCond(Number.isInteger(parsed.guess_id) && parsed.guess_id >= 0, 'guess_id must be non-negative integer');
  assertCond(/^\d+$/.test(parsed.commitment), 'commitment must be decimal string');
  assertCond(Number.isInteger(parsed.exact) && parsed.exact >= 0 && parsed.exact <= 4, 'exact must be 0..4');
  assertCond(Number.isInteger(parsed.partial) && parsed.partial >= 0 && parsed.partial <= 4, 'partial must be 0..4');
  assertCond(parsed.exact + parsed.partial <= 4, 'exact + partial must be <= 4');
  return parsed;
}

export function json(res: ApiRes, status: number, payload: unknown) {
  res.status(status).json(payload);
}

export function allowCors(res: ApiRes) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

export function methodNotAllowed(res: ApiRes) {
  json(res, 405, { error: 'method_not_allowed' });
}

export function parseRequestBody(req: ApiReq): Record<string, unknown> {
  return toJsonBody(req);
}

export function computeCommitment(secret: Guess4, salt: Salt16): string {
  const preimage = Buffer.from([...secret, ...salt]);
  const digest = createHash('blake2s256').update(preimage).digest();
  let value = 0n;
  for (let i = 0; i < 31; i++) {
    value = (value << 8n) + BigInt(digest[i]);
  }
  return value.toString();
}
