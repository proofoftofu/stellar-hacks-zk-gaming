import {
  allowCors,
  computeCommitment,
  json,
  methodNotAllowed,
  normalizeCommitmentBody,
  parseRequestBody,
} from './shared.js';

export default async function handler(req, res) {
  allowCors(res);
  if (req.method === 'OPTIONS') {
    return json(res, 200, { ok: true });
  }
  if (req.method !== 'POST') {
    return methodNotAllowed(res);
  }

  try {
    const body = parseRequestBody(req);
    const { secret, salt } = normalizeCommitmentBody(body);
    return json(res, 200, { commitment: computeCommitment(secret, salt) });
  } catch (error) {
    return json(res, 400, { error: String(error) });
  }
}
