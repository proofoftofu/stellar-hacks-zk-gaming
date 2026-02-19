#!/usr/bin/env node

import crypto from "node:crypto";

function parseCsv(arg, expectedLen, name) {
  const parts = String(arg || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length !== expectedLen) {
    throw new Error(`${name} must contain exactly ${expectedLen} comma-separated values`);
  }
  return parts.map((p) => {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      throw new Error(`${name} contains invalid byte: ${p}`);
    }
    return n;
  });
}

function blakeCommitment(secret, salt) {
  const preimage = Buffer.from([...secret, ...salt]);
  const digest = crypto.createHash("blake2s256").update(preimage).digest();
  let value = 0n;
  for (let i = 0; i < 31; i++) {
    value = (value << 8n) + BigInt(digest[i]);
  }
  return { digestHex: digest.toString("hex"), commitment: value.toString() };
}

function main() {
  const secretArg = process.argv[2] || "1,2,3,4";
  const saltArg = process.argv[3] || "11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26";
  const secret = parseCsv(secretArg, 4, "secret");
  const salt = parseCsv(saltArg, 16, "salt");
  const out = blakeCommitment(secret, salt);
  console.log(`secret: ${secret.join(",")}`);
  console.log(`salt:   ${salt.join(",")}`);
  console.log(`blake2s: ${out.digestHex}`);
  console.log(`commitment: ${out.commitment}`);
}

main();
