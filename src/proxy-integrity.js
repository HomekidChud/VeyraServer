"use strict";
const crypto = require("node:crypto");
function verifyIntegrity(bytes, metadata) {
  if (typeof metadata !== "string" || metadata.length > 4096) return false;
  const hashes = metadata.trim().split(/\s+/).map(t => t.match(/^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/)).filter(Boolean);
  if (!hashes.length) return false;
  const strength = Math.max(...hashes.map(x => Number(x[1].slice(3))));
  return hashes.filter(x => Number(x[1].slice(3)) === strength).some(([, algorithm, expected]) => {
    const digest = crypto.createHash(algorithm).update(bytes).digest();
    const declared = Buffer.from(expected, "base64");
    return declared.length === digest.length && crypto.timingSafeEqual(declared, digest);
  });
}
module.exports = { verifyIntegrity };
