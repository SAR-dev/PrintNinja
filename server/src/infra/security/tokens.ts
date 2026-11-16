import { createHash, randomBytes, randomInt } from "node:crypto";
import type { TokenService } from "../../domain/ports.js";

/**
 * Opaque session tokens: 32 random bytes as base64url, stored as
 * SHA-256 hex. The same shape as the Rust server, so imported sessions
 * keep working — the token is opaque and the hash function is unchanged.
 */
export function createTokenService(): TokenService {
  return {
    generate() {
      const token = randomBytes(32).toString("base64url");
      return { token, tokenHash: hashToken(token) };
    },
    hash(token) {
      return hashToken(token);
    },
    generateRecoveryCode() {
      let raw = "";
      for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) {
        raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
      }
      return { code: groupCode(raw), codeHash: hashToken(raw) };
    },
    hashRecoveryCode(code) {
      return hashToken(normalizeCode(code));
    },
  };
}

// 32 characters with no 0/O/1/I, so a code read off paper survives.
// 20 characters = 100 bits: a fast SHA-256 is plenty for something this
// random (it is not a human-chosen password).
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_CODE_LENGTH = 20;

function groupCode(raw: string): string {
  return raw.match(/.{1,5}/g)?.join("-") ?? raw;
}

function normalizeCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
