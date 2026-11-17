// Ports (REFACTORING.md section 5): the interfaces the domain needs.
// Infrastructure implements them; unit tests fake them. The domain never
// imports Fastify or Prisma — the layer check enforces it.

import type {
  DatasetRepository,
  FontRepository,
  ProfileRepository,
  SettingRepository,
} from "./libraryPorts.js";
import type { SavedRepository, TemplateRepository } from "./templatePorts.js";
import type { SyncRepository } from "./syncPorts.js";

export interface UserRecord {
  id: string;
  handle: string;
  handleKey: string;
  passwordHash: string;
  /** SHA-256 hex of the recovery code; null for accounts that never
   * made one (created before recovery codes existed). */
  recoveryCodeHash: string | null;
  createdAt: Date;
}

export interface SessionRecord {
  tokenHash: string;
  /** Opaque id for the sessions API. Never the token or its hash. */
  publicId: string;
  userId: string;
  /** Short label from the User-Agent at sign-in ("Android", "Windows"). */
  deviceLabel: string;
  lastUsedAt: Date;
  createdAt: Date;
  expiresAt: Date;
}

export interface UserRepository {
  findByHandleKey(handleKey: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  /** Creates the user and its user_sync row atomically. Throws
   * HandleTakenError when the handle key is already taken (covers the
   * check-then-insert race, not just the pre-check). */
  create(input: {
    id: string;
    handle: string;
    handleKey: string;
    passwordHash: string;
    /** Omitted for accounts made without one (seed and import scripts). */
    recoveryCodeHash?: string;
  }): Promise<UserRecord>;
  /** Replaces the stored hash (D13: legacy scrypt rehash on login). */
  updatePasswordHash(id: string, passwordHash: string): Promise<void>;
  /** Stores the hash of a freshly issued recovery code, replacing any
   * earlier one (a code works once, then it is rotated). */
  setRecoveryCodeHash(id: string, recoveryCodeHash: string): Promise<void>;
  /** Renames the account (handle + its unique key). Throws
   * HandleTakenError when the new key is another user's, covering the
   * check-then-update race the same way create does. */
  updateHandle(
    id: string,
    handle: string,
    handleKey: string,
  ): Promise<UserRecord>;
}

export interface SessionRepository {
  create(input: {
    tokenHash: string;
    userId: string;
    expiresAt: Date;
    deviceLabel: string;
  }): Promise<SessionRecord>;
  /** The session with its user, for request authentication. */
  findWithUser(
    tokenHash: string,
  ): Promise<{ session: SessionRecord; user: UserRecord } | null>;
  /** Logout is idempotent: unknown tokens delete nothing and still succeed. */
  deleteByTokenHash(tokenHash: string): Promise<void>;
  /** Deletes sessions expired at or before now. Returns the count. */
  deleteExpired(now: Date): Promise<number>;
  /**
   * Kills every session of a user except one (password change,
   * "log out everywhere"): the current device stays signed in.
   * Returns the revoked count.
   */
  deleteOthersForUser(userId: string, exceptTokenHash: string): Promise<number>;
  /**
   * Keeps only the newest keepNewest sessions of a user (by creation),
   * deleting the rest oldest-first. Returns the deleted count. Bounds
   * per-user session growth from devices that log in but never log out.
   */
  deleteOldestForUser(userId: string, keepNewest: number): Promise<number>;
  /** The user's live sessions (expiry checked by the caller), newest
   * last-used first — the signed-in devices list. */
  listForUser(userId: string): Promise<SessionRecord[]>;
  /** Deletes one session by its public id, scoped to the owner (a
   * foreign or unknown id deletes nothing and reports false). */
  deleteByPublicId(userId: string, publicId: string): Promise<boolean>;
  /** Records a use for the last-used column; called at most once per
   * touch interval per session, so it is one cheap UPDATE. */
  touch(tokenHash: string, lastUsedAt: Date): Promise<void>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(storedHash: string, password: string): Promise<boolean>;
  /** True when a verified password should be rehashed to the current
   * algorithm (D13: a legacy scrypt hash pays its 128 MiB/400 ms on
   * exactly one login, then becomes argon2id). */
  needsRehash(storedHash: string): boolean;
}

export interface TokenService {
  /** 32 random bytes as base64url, plus its SHA-256 hex. The hash is
   * stored; the token is sent to the client and never stored. */
  generate(): { token: string; tokenHash: string };
  hash(token: string): string;
  /** A one-time account recovery code: 20 random characters from an
   * unambiguous alphabet, shown as XXXXX-XXXXX-XXXXX-XXXXX. Only the
   * hash is stored. */
  generateRecoveryCode(): { code: string; codeHash: string };
  /** Hash of a typed code. Case, dashes and spaces are ignored. */
  hashRecoveryCode(code: string): string;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  newId(): string;
}

/** Everything the auth domain needs. buildApp wires the real
 * implementations; tests pass fakes. */
export interface AuthDeps {
  users: UserRepository;
  sessions: SessionRepository;
  hasher: PasswordHasher;
  tokens: TokenService;
  clock: Clock;
  ids: IdGenerator;
  /** Days until a new session expires. */
  sessionTtlDays: number;
}

/** Everything the app wires. buildApp takes this whole; tests pass
 * fakes for the parts under test. */
export interface AppDeps extends AuthDeps {
  templates: TemplateRepository;
  saved: SavedRepository;
  sync: SyncRepository;
  datasets: DatasetRepository;
  profiles: ProfileRepository;
  settings: SettingRepository;
  fonts: FontRepository;
  /**
   * Database round-trip for /v2/ready. Optional so unit tests can run
   * without a database; readiness then answers 503 (see healthRoutes)
   * instead of claiming a probe that never ran.
   */
  ping?: () => Promise<void>;
}
