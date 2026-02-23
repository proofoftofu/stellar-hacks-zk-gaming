import { Buffer } from 'node:buffer';
import { proveTurnWithJs } from './zkJsProver.js';
import {
  allowCors,
  json,
  methodNotAllowed,
  normalizeProveBody,
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
    const parsed = normalizeProveBody(body);
    const proofBlob = await proveTurnWithJs({
      sessionId: parsed.session_id,
      guessId: parsed.guess_id,
      commitmentDec: parsed.commitment,
      guess: parsed.guess,
      exact: parsed.exact,
      partial: parsed.partial,
      secret: parsed.secret,
      salt: parsed.salt,
    });

    return json(res, 200, {
      ok: true,
      proof_blob_base64: Buffer.from(proofBlob).toString('base64'),
    });
  } catch (error) {
    return json(res, 400, { error: String(error) });
  }
}
