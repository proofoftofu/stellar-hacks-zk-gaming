import {
  allowCors,
  computeCommitment,
  json,
  methodNotAllowed,
  normalizeCommitmentBody,
  parseRequestBody,
} from './_shared';

type ApiReq = {
  method?: string;
  body?: unknown;
};

type ApiRes = {
  status: (code: number) => ApiRes;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
};

export default async function handler(req: ApiReq, res: ApiRes) {
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
