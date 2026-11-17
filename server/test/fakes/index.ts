import { randomUUID } from "node:crypto";
import { HandleTakenError } from "../../src/domain/errors.js";
import type {
  Clock,
  IdGenerator,
  PasswordHasher,
  SessionRecord,
  SessionRepository,
  TokenService,
  UserRecord,
  UserRepository,
} from "../../src/domain/ports.js";

// In-memory ports for domain unit tests (REFACTORING.md section 5).
// Behaviour matches the contracts in domain/ports.ts, including the
// duplicate-handle race mapping. Anything slower or more real (a file database,
// argon2) belongs in test/integration/.

/** Shared fake epoch, same as the library/template fakes. */
const BASE_MS = new Date("2026-10-20T00:00:00Z").getTime();

export function createFakeUsers(): UserRepository & {
  byId: Map<string, UserRecord>;
} {
  const byId = new Map<string, UserRecord>();
  const byKey = new Map<string, UserRecord>();
  return {
    byId,
    async findByHandleKey(handleKey) {
      return byKey.get(handleKey) ?? null;
    },
    async findById(id) {
      return byId.get(id) ?? null;
    },
    async create(input) {
      if (byKey.has(input.handleKey)) {
        throw new HandleTakenError();
      }
      const user: UserRecord = {
        ...input,
        recoveryCodeHash: input.recoveryCodeHash ?? null,
        createdAt: new Date("2026-10-20T00:00:00Z"),
      };
      byId.set(user.id, user);
      byKey.set(user.handleKey, user);
      return user;
    },
    async setRecoveryCodeHash(id, recoveryCodeHash) {
      const user = byId.get(id);
      if (user) {
        byId.set(id, { ...user, recoveryCodeHash });
        byKey.set(user.handleKey, { ...user, recoveryCodeHash });
      }
    },
    async updatePasswordHash(id, passwordHash) {
      const user = byId.get(id);
      if (user) {
        byId.set(id, { ...user, passwordHash });
        byKey.set(user.handleKey, { ...user, passwordHash });
      }
    },
    async updateHandle(id, handle, handleKey) {
      const user = byId.get(id);
      if (!user) {
        throw new Error("user not found");
      }
      const occupant = byKey.get(handleKey);
      if (occupant && occupant.id !== id) {
        throw new HandleTakenError();
      }
      const updated = { ...user, handle, handleKey };
      byKey.delete(user.handleKey);
      byId.set(id, updated);
      byKey.set(handleKey, updated);
      return updated;
    },
  };
}

export function createFakeSessions(users: {
  byId: Map<string, UserRecord>;
}): SessionRepository {
  const byHash = new Map<string, SessionRecord>();
  let tick = 0;
  // Store wall time from the shared fake epoch, so rows line up with
  // createFakeClock(2026-10-20) and each row gets a distinct instant.
  const now = () => new Date(BASE_MS + tick++ * 1000);
  return {
    async create(input) {
      const timestamp = now();
      const session: SessionRecord = {
        tokenHash: input.tokenHash,
        publicId: randomUUID(),
        userId: input.userId,
        deviceLabel: input.deviceLabel,
        lastUsedAt: timestamp,
        createdAt: timestamp,
        expiresAt: input.expiresAt,
      };
      byHash.set(session.tokenHash, session);
      return session;
    },
    async findWithUser(tokenHash) {
      const session = byHash.get(tokenHash) ?? null;
      if (!session) {
        return null;
      }
      const user = users.byId.get(session.userId) ?? null;
      if (!user) {
        return null;
      }
      return { session, user };
    },
    async deleteByTokenHash(tokenHash) {
      byHash.delete(tokenHash);
    },
    async deleteExpired(now) {
      let count = 0;
      for (const [hash, session] of byHash) {
        if (session.expiresAt <= now) {
          byHash.delete(hash);
          count += 1;
        }
      }
      return count;
    },
    async deleteOldestForUser(userId, keepNewest) {
      const owned = [...byHash.values()]
        .filter((session) => session.userId === userId)
        // Map iteration order is insertion order: oldest first.
        .map((session) => session.tokenHash);
      const surplus = owned.slice(0, Math.max(owned.length - keepNewest, 0));
      for (const hash of surplus) {
        byHash.delete(hash);
      }
      return surplus.length;
    },
    async deleteOthersForUser(userId, exceptTokenHash) {
      let count = 0;
      for (const [hash, session] of byHash) {
        if (session.userId === userId && hash !== exceptTokenHash) {
          byHash.delete(hash);
          count += 1;
        }
      }
      return count;
    },
    async listForUser(userId) {
      // Mirrors the Prisma order: last-used desc, then created desc.
      return [...byHash.values()]
        .filter((session) => session.userId === userId)
        .sort(
          (a, b) =>
            b.lastUsedAt.getTime() - a.lastUsedAt.getTime() ||
            b.createdAt.getTime() - a.createdAt.getTime(),
        );
    },
    async deleteByPublicId(userId, publicId) {
      for (const [hash, session] of byHash) {
        if (session.userId === userId && session.publicId === publicId) {
          byHash.delete(hash);
          return true;
        }
      }
      return false;
    },
    async touch(tokenHash, lastUsedAt) {
      const session = byHash.get(tokenHash);
      if (session) {
        session.lastUsedAt = lastUsedAt;
      }
    },
  };
}

export function createFakeHasher(): PasswordHasher {
  return {
    async hash(password) {
      return `fake-hash:${password}`;
    },
    async verify(storedHash, password) {
      return storedHash === `fake-hash:${password}`;
    },
    needsRehash(storedHash) {
      return !storedHash.startsWith("fake-hash:");
    },
  };
}

export function createFakeTokens(): TokenService & { count: number } {
  let count = 0;
  let recoveryCount = 0;
  const service: TokenService & { count: number } = {
    count: 0,
    generate() {
      count += 1;
      service.count = count;
      return {
        token: `token-${count}`,
        tokenHash: `hash-of:token-${count}`,
      };
    },
    hash(token) {
      return `hash-of:${token}`;
    },
    generateRecoveryCode() {
      recoveryCount += 1;
      const code = `CODE${recoveryCount}-AAAAA-BBBBB-CCCCC`;
      return { code, codeHash: `recovery-hash-of:${recoveryCount}` };
    },
    hashRecoveryCode(code) {
      // Mirrors the real normalisation: case, dashes and spaces ignored.
      const match = /^CODE(\d+)/.exec(
        code.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
      );
      return match
        ? `recovery-hash-of:${match[1]}`
        : `recovery-hash-of:bad:${code}`;
    },
  };
  return service;
}

export function createFakeClock(fixed: Date): Clock {
  return { now: () => new Date(fixed) };
}

export function createFakeIds(ids: string[]): IdGenerator {
  const queue = [...ids];
  return {
    newId() {
      const next = queue.shift();
      if (!next) {
        throw new Error("fake ids exhausted");
      }
      return next;
    },
  };
}
