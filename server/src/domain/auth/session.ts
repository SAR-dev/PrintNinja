import { UnauthorizedError } from "../errors.js";
import type { AuthDeps, SessionRecord, UserRecord } from "../ports.js";

/**
 * Sessions kept per user. Logins mint a row each; devices rarely log
 * out, so without pruning one user grows a row per login until the
 * 30-day TTL purge. 20 covers a phone, a tablet, a desktop and plenty
 * of reinstalls.
 */
export const MAX_SESSIONS_PER_USER = 20;

/** Last-used moves at most once per interval, so an active session
 * pays one UPDATE per five minutes instead of one per request. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;

/** Fallback excerpt when a User-Agent matches no known platform. */
export const DEVICE_LABEL_MAX = 80;

/**
 * A short label for one row of the signed-in devices list, derived from
 * the User-Agent at sign-in: the platform family when recognizable, a
 * truncated excerpt otherwise, "Unknown device" with no header. Never
 * empty, so a row always has something to show.
 */
export function deviceLabelFromUserAgent(
  userAgent: string | undefined,
): string {
  const ua = (userAgent ?? "").trim();
  if (ua.length === 0) {
    return "Unknown device";
  }
  const platform = /\bAndroid\b/.test(ua)
    ? "Android"
    : /\b(?:iPhone|iPad|iPod)\b/.test(ua)
      ? "iOS"
      : /\bWindows\b/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /\b(?:Linux|X11|CrOS)\b/.test(ua)
            ? "Linux"
            : null;
  return platform ?? ua.slice(0, DEVICE_LABEL_MAX);
}

export interface SessionResult {
  user: UserRecord;
  session: SessionRecord;
}

/**
 * Resolves a bearer token to its user. Missing, malformed, unknown and
 * expired tokens all give the same UnauthorizedError (401) — the route
 * must not distinguish them. A live session's last-used stamp moves
 * once per SESSION_TOUCH_INTERVAL_MS.
 */
export async function validateSession(
  deps: AuthDeps,
  token: string,
): Promise<SessionResult> {
  if (!token || /\s/.test(token)) {
    throw new UnauthorizedError();
  }
  const tokenHash = deps.tokens.hash(token);
  const found = await deps.sessions.findWithUser(tokenHash);
  const now = deps.clock.now();
  if (!found || found.session.expiresAt <= now) {
    throw new UnauthorizedError();
  }
  if (
    now.getTime() - found.session.lastUsedAt.getTime() >=
    SESSION_TOUCH_INTERVAL_MS
  ) {
    await deps.sessions.touch(tokenHash, now);
    found.session = { ...found.session, lastUsedAt: now };
  }
  return { user: found.user, session: found.session };
}

/**
 * Ends one session. Idempotent: an unknown token deletes nothing and
 * still succeeds, so a retried logout is a 204, not a 404.
 */
export async function logoutUser(deps: AuthDeps, token: string): Promise<void> {
  if (!token || /\s/.test(token)) {
    throw new UnauthorizedError();
  }
  await deps.sessions.deleteByTokenHash(deps.tokens.hash(token));
}

/**
 * Ends every session of a user except the calling one. After a password
 * change (or a lost device) this is how the account is taken back: the
 * current token keeps working, everything else 401s on next use.
 */
export async function revokeOtherSessions(
  deps: AuthDeps,
  userId: string,
  currentToken: string,
): Promise<number> {
  return deps.sessions.deleteOthersForUser(
    userId,
    deps.tokens.hash(currentToken),
  );
}

/** One row of the signed-in devices list. */
export interface SessionView {
  /** Opaque public id — the handle DELETE /v2/auth/sessions/:id takes. */
  id: string;
  deviceLabel: string;
  /** True for the session making the request. */
  current: boolean;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

/**
 * The account's live sessions, most recently used first, with the
 * calling session marked current. Expired rows are dropped — they are
 * dead even before the purge timer collects them.
 */
export async function listUserSessions(
  deps: AuthDeps,
  userId: string,
  currentPublicId: string,
): Promise<SessionView[]> {
  const now = deps.clock.now();
  const sessions = await deps.sessions.listForUser(userId);
  return sessions
    .filter((session) => session.expiresAt > now)
    .map((session) => ({
      id: session.publicId,
      deviceLabel: session.deviceLabel,
      current: session.publicId === currentPublicId,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
    }));
}

/**
 * Ends one session by its public id, scoped to the owner: a foreign or
 * unknown id reports false and deletes nothing (indistinguishable, so
 * ids cannot be probed across accounts). Revoking the calling session
 * is allowed — it is a logout by another name.
 */
export async function revokeSession(
  deps: AuthDeps,
  userId: string,
  publicId: string,
): Promise<boolean> {
  if (!publicId) {
    return false;
  }
  return deps.sessions.deleteByPublicId(userId, publicId);
}

/**
 * Deletes sessions expired at or before now. Runs at startup and on the
 * hourly timer (no job queue); tombstones are Phase 2's stream, so
 * sessions are all this pass touches.
 */
export async function purgeExpiredSessions(
  deps: Pick<AuthDeps, "sessions" | "clock">,
): Promise<number> {
  return deps.sessions.deleteExpired(deps.clock.now());
}
