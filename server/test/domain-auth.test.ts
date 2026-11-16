import { describe, expect, it } from "vitest";
import {
  createFakeClock,
  createFakeHasher,
  createFakeIds,
  createFakeSessions,
  createFakeTokens,
  createFakeUsers,
} from "./fakes/index.js";
import {
  changePassword,
  DEVICE_LABEL_MAX,
  issueRecoveryCode,
  deviceLabelFromUserAgent,
  listUserSessions,
  loginUser,
  logoutUser,
  MAX_SESSIONS_PER_USER,
  purgeExpiredSessions,
  registerUser,
  resetPassword,
  revokeOtherSessions,
  revokeSession,
  validateSession,
} from "../src/domain/auth/index.js";
import {
  ForbiddenError,
  HandleTakenError,
  InvalidCredentialsError,
  InvalidRecoveryCodeError,
  UnauthorizedError,
  ValidationError,
} from "../src/domain/errors.js";
import type { AuthDeps } from "../src/domain/ports.js";

const PASSWORD = "password123";

function deps(): AuthDeps {
  const users = createFakeUsers();
  return {
    users,
    sessions: createFakeSessions(users),
    hasher: createFakeHasher(),
    tokens: createFakeTokens(),
    clock: createFakeClock(new Date("2026-10-20T00:00:00Z")),
    ids: createFakeIds(["user-1", "user-2"]),
    sessionTtlDays: 30,
  };
}

async function registered(deps: AuthDeps, handle = "Alice") {
  return registerUser(deps, { handle, password: PASSWORD });
}

describe("registerUser", () => {
  it("creates the user, keeps the typed handle, and returns a session", async () => {
    const result = await registered(deps());

    expect(result.user.handle).toBe("Alice");
    expect(result.user.id).toBe("user-1");
    expect(result.token).toBe("token-1");
    expect(result.expiresAt.toISOString()).toBe("2026-11-19T00:00:00.000Z");
    expect(result.user.createdAt.toISOString()).toBe(
      "2026-10-20T00:00:00.000Z",
    );
  });

  it("matches the duplicate case-insensitively", async () => {
    const d = deps();
    await registered(d, "Alice");

    await expect(registered(d, "alice")).rejects.toBeInstanceOf(
      HandleTakenError,
    );
    await expect(registered(d, "ALICE")).rejects.toBeInstanceOf(
      HandleTakenError,
    );
  });

  it("rejects an invalid handle or password without touching the store", async () => {
    const d = deps();

    for (const handle of ["", "a".repeat(33), "has space", "semi;colon"]) {
      await expect(
        registerUser(d, { handle, password: PASSWORD }),
      ).rejects.toThrow("handle");
    }
    for (const password of ["short", "a".repeat(129)]) {
      await expect(
        registerUser(d, { handle: "bob", password }),
      ).rejects.toThrow("password");
    }
    expect(await d.users.findByHandleKey("bob")).toBeNull();
  });

  it("trims the handle before storing", async () => {
    const d = deps();
    const result = await registered(d, "  bob  ");

    expect(result.user.handle).toBe("bob");
    await expect(registered(d, "bob")).rejects.toBeInstanceOf(HandleTakenError);
  });

  it("stores a hash, never the password", async () => {
    const d = deps();
    const result = await registered(d);

    const stored = await d.users.findById(result.user.id);
    expect(stored?.passwordHash).not.toBe(PASSWORD);
    expect(stored?.passwordHash).toContain(PASSWORD);
  });
});

describe("loginUser", () => {
  it("returns a new session for the stored handle casing", async () => {
    const d = deps();
    await registered(d, "Alice");

    const result = await loginUser(d, {
      handle: "ALICE",
      password: PASSWORD,
    });

    expect(result.user.handle).toBe("Alice");
    expect(result.token).toBe("token-2");
    expect(result.expiresAt.toISOString()).toBe("2026-11-19T00:00:00.000Z");
  });

  it("gives the same answer for an unknown handle and a wrong password", async () => {
    const d = deps();
    await registered(d, "bob");

    const wrongPassword = loginUser(d, {
      handle: "bob",
      password: "wrongpassword",
    });
    const unknownHandle = loginUser(d, {
      handle: "nobody",
      password: PASSWORD,
    });

    await expect(wrongPassword).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(unknownHandle).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(wrongPassword).rejects.toThrow("Invalid handle or password");
    await expect(unknownHandle).rejects.toThrow("Invalid handle or password");
  });

  it("still verifies a password for an unknown handle (no timing oracle)", async () => {
    const d = deps();
    await registered(d, "bob");
    let verifications = 0;
    const inner = d.hasher.verify.bind(d.hasher);
    d.hasher = {
      ...d.hasher,
      verify: async (storedHash, password) => {
        verifications += 1;
        return inner(storedHash, password);
      },
    };

    await expect(
      loginUser(d, { handle: "nobody", password: PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    expect(verifications).toBe(1);
  });

  it("caps sessions per user, keeping the newest", async () => {
    const d = deps();
    const first = await registered(d, "carol");
    expect(first.token).toBe("token-1");

    let last = "";
    for (let i = 0; i < 25; i++) {
      last = (await loginUser(d, { handle: "carol", password: PASSWORD }))
        .token;
    }

    // 1 register + 25 logins, capped at MAX_SESSIONS_PER_USER.
    const survivors: string[] = [];
    for (let i = 1; i <= 26; i++) {
      const session = await validateSession(d, `token-${i}`).catch(() => null);
      if (session) survivors.push(`token-${i}`);
    }
    expect(survivors).toHaveLength(MAX_SESSIONS_PER_USER);
    expect(survivors).toContain(last);
    expect(survivors).not.toContain("token-1");
  });

  it("rehashes a legacy scrypt password to the current algorithm on login", async () => {
    const d = deps();
    const legacy = "$scrypt$ln=17,r=8,p=1$c2FsdA$bWFzaA";
    await d.users.create({
      id: "user-9",
      handle: "old",
      handleKey: "old",
      passwordHash: legacy,
    });
    // Inline double: the shared fake never produces legacy hashes.
    d.hasher = {
      hash: async (password: string) => `argon2id:${password}`,
      verify: async (storedHash: string, password: string) =>
        storedHash === legacy && password === PASSWORD,
      needsRehash: (storedHash: string) => storedHash.startsWith("$scrypt$"),
    };

    const result = await loginUser(d, { handle: "old", password: PASSWORD });

    expect(result.user.passwordHash).toBe(`argon2id:${PASSWORD}`);
    expect((await d.users.findById("user-9"))?.passwordHash).toBe(
      `argon2id:${PASSWORD}`,
    );
  });
});

describe("logoutUser and validateSession", () => {
  it("validates a live session, then forgets it on logout", async () => {
    const d = deps();
    const { token } = await registered(d);

    const session = await validateSession(d, token);
    expect(session.user.handle).toBe("Alice");

    await logoutUser(d, token);
    await expect(validateSession(d, token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("logout is idempotent: an unknown token still succeeds", async () => {
    await expect(logoutUser(deps(), "nope")).resolves.toBeUndefined();
  });

  it("revokeOtherSessions keeps the caller and kills the rest", async () => {
    const d = deps();
    const first = await registered(d);
    const second = await loginUser(d, { handle: "Alice", password: PASSWORD });
    expect(second.token).not.toBe(first.token);

    const revoked = await revokeOtherSessions(d, first.user.id, first.token);
    expect(revoked).toBe(1);

    // The caller still validates; the other session is gone.
    await expect(validateSession(d, first.token)).resolves.toMatchObject({
      user: { handle: "Alice" },
    });
    await expect(validateSession(d, second.token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );

    // Nothing left to revoke is not an error.
    await expect(
      revokeOtherSessions(d, first.user.id, first.token),
    ).resolves.toBe(0);
  });

  it("changePassword needs the current password and revokes the rest", async () => {
    const d = deps();
    const first = await registered(d);
    const second = await loginUser(d, { handle: "Alice", password: PASSWORD });

    // A wrong current password fails like a bad login, changing nothing.
    await expect(
      changePassword(
        d,
        first.user,
        "not-the-password",
        "new-password-1",
        first.token,
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(validateSession(d, first.token)).resolves.toBeTruthy();

    const { revoked } = await changePassword(
      d,
      first.user,
      PASSWORD,
      "new-password-1",
      first.token,
    );
    expect(revoked).toBe(1);

    // The new password logs in; the old one does not; the other
    // session died with the change.
    await expect(
      loginUser(d, { handle: "Alice", password: "new-password-1" }),
    ).resolves.toMatchObject({ user: { handle: "Alice" } });
    await expect(
      loginUser(d, { handle: "Alice", password: PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(validateSession(d, second.token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(validateSession(d, first.token)).resolves.toBeTruthy();
  });

  it("rejects missing, malformed, unknown and expired tokens alike", async () => {
    const d = deps();
    const { token } = await registered(d);

    for (const bad of ["", "not-a-token", "Bearer " + token]) {
      await expect(validateSession(d, bad)).rejects.toBeInstanceOf(
        UnauthorizedError,
      );
    }
    // Expire the session by moving the clock past its TTL.
    d.clock = createFakeClock(new Date("2027-10-20T00:00:00Z"));
    await expect(validateSession(d, token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});

describe("purgeExpiredSessions", () => {
  it("deletes only the expired sessions and reports the count", async () => {
    const d = deps();
    const { token, user } = await registered(d);
    await d.sessions.create({
      tokenHash: "expired-hash",
      userId: user.id,
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      deviceLabel: "Test device",
    });

    expect(await purgeExpiredSessions(d)).toBe(1);
    await expect(validateSession(d, token)).resolves.toMatchObject({
      user: { id: user.id },
    });
  });

  it("reports zero when nothing is expired", async () => {
    const d = deps();
    await registered(d);

    expect(await purgeExpiredSessions(d)).toBe(0);
  });
});

describe("deviceLabelFromUserAgent", () => {
  it("names the platform family when the User-Agent is recognizable", () => {
    expect(
      deviceLabelFromUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120 Mobile Safari/537.36",
      ),
    ).toBe("Android");
    expect(
      deviceLabelFromUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131",
      ),
    ).toBe("Windows");
    expect(
      deviceLabelFromUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      ),
    ).toBe("macOS");
    // iOS says "like Mac OS X" — the device family wins over the hint.
    expect(
      deviceLabelFromUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15",
      ),
    ).toBe("iOS");
    expect(
      deviceLabelFromUserAgent("Mozilla/5.0 (X11; Linux x86_64) Chrome/131"),
    ).toBe("Linux");
  });

  it("falls back to a bounded excerpt and never returns empty", () => {
    expect(deviceLabelFromUserAgent(undefined)).toBe("Unknown device");
    expect(deviceLabelFromUserAgent("   ")).toBe("Unknown device");
    expect(deviceLabelFromUserAgent("curl/8.5.0")).toBe("curl/8.5.0");
    expect(deviceLabelFromUserAgent("device ".repeat(100))).toHaveLength(
      DEVICE_LABEL_MAX,
    );
  });
});

describe("listUserSessions and revokeSession", () => {
  it("labels sessions at sign-in and marks only the caller current", async () => {
    const d = deps();
    const first = await registerUser(
      d,
      { handle: "Alice", password: PASSWORD },
      { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)" },
    );
    const second = await loginUser(
      d,
      { handle: "Alice", password: PASSWORD },
      { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    );
    const secondSession = await d.sessions.findWithUser(
      d.tokens.hash(second.token),
    );

    const list = await listUserSessions(
      d,
      first.user.id,
      secondSession?.session.publicId ?? "",
    );
    expect(list).toHaveLength(2);
    // Most recently used first: the login just happened.
    expect(list[0]?.deviceLabel).toBe("Windows");
    expect(list[0]?.current).toBe(true);
    expect(list[1]?.deviceLabel).toBe("Android");
    expect(list[1]?.current).toBe(false);
    // Neither the tokens nor their hashes appear in the view.
    const wire = JSON.stringify(list);
    expect(wire).not.toContain(first.token);
    expect(wire).not.toContain(second.token);
    expect(wire).not.toContain(d.tokens.hash(first.token));
  });

  it("drops expired sessions from the list", async () => {
    const d = deps();
    const { user, token } = await registered(d);
    await d.sessions.create({
      tokenHash: "dead-hash",
      userId: user.id,
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      deviceLabel: "Old phone",
    });
    const session = await d.sessions.findWithUser(d.tokens.hash(token));

    const list = await listUserSessions(
      d,
      user.id,
      session?.session.publicId ?? "",
    );
    expect(list.map((s) => s.deviceLabel)).toEqual(["Unknown device"]);
  });

  it("revokes one session by id, scoped to the owner", async () => {
    const d = deps();
    const first = await registered(d);
    const second = await loginUser(d, { handle: "Alice", password: PASSWORD });
    const secondSession = await d.sessions.findWithUser(
      d.tokens.hash(second.token),
    );
    const secondId = secondSession?.session.publicId ?? "";

    // Unknown and empty ids report false, deleting nothing.
    await expect(revokeSession(d, first.user.id, "nope")).resolves.toBe(false);
    await expect(revokeSession(d, first.user.id, "")).resolves.toBe(false);

    // Another user's session id is indistinguishable from unknown.
    await expect(revokeSession(d, "someone-else", secondId)).resolves.toBe(
      false,
    );
    await expect(validateSession(d, second.token)).resolves.toBeTruthy();

    // The owner revokes it: that token dies, the caller survives.
    await expect(revokeSession(d, first.user.id, secondId)).resolves.toBe(true);
    await expect(validateSession(d, second.token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(validateSession(d, first.token)).resolves.toBeTruthy();
  });

  it("moves last-used at most once per touch interval", async () => {
    const d = deps();
    const { token } = await registered(d);
    const hash = d.tokens.hash(token);
    const initial = (await d.sessions.findWithUser(hash))?.session.lastUsedAt;
    expect(initial?.toISOString()).toBe("2026-10-20T00:00:00.000Z");

    // Same instant: within the interval, no write.
    await validateSession(d, token);
    expect((await d.sessions.findWithUser(hash))?.session.lastUsedAt).toEqual(
      initial,
    );

    // Past the interval: the stamp moves to the new now.
    d.clock = createFakeClock(new Date("2026-10-20T00:06:00Z"));
    await validateSession(d, token);
    expect(
      (await d.sessions.findWithUser(hash))?.session.lastUsedAt.toISOString(),
    ).toBe("2026-10-20T00:06:00.000Z");
  });
});

describe("recovery code and password reset", () => {
  it("register returns a recovery code and stores only its hash", async () => {
    const d = deps();
    const result = await registered(d);

    expect(result.recoveryCode).toMatch(/^CODE\d+-/);
    const stored = await d.users.findById(result.user.id);
    expect(stored?.recoveryCodeHash).toBe(
      d.tokens.hashRecoveryCode(result.recoveryCode),
    );
    expect(stored?.recoveryCodeHash).not.toContain(result.recoveryCode);
  });

  it("resets the password with the code, rotates the code, signs everything out", async () => {
    const d = deps();
    const { user, token, recoveryCode } = await registered(d);
    await loginUser(d, { handle: "Alice", password: PASSWORD }); // 2nd device

    const result = await resetPassword(d, {
      handle: "alice", // case-insensitive, like login
      recoveryCode: recoveryCode.toLowerCase().replaceAll("-", " "),
      newPassword: "a brand new one",
    });

    expect(result.revoked).toBe(2);
    expect(result.recoveryCode).not.toBe(recoveryCode);
    await expect(validateSession(d, token)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    await expect(
      loginUser(d, { handle: "Alice", password: PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    const login = await loginUser(d, {
      handle: "Alice",
      password: "a brand new one",
    });
    expect(login.user.id).toBe(user.id);
  });

  it("a recovery code works only once", async () => {
    const d = deps();
    const { recoveryCode } = await registered(d);
    await resetPassword(d, {
      handle: "Alice",
      recoveryCode,
      newPassword: "first new password",
    });

    await expect(
      resetPassword(d, {
        handle: "Alice",
        recoveryCode,
        newPassword: "second new password",
      }),
    ).rejects.toBeInstanceOf(InvalidRecoveryCodeError);
  });

  it("answers one error for a wrong code, an unknown handle and a missing code", async () => {
    const d = deps();
    const { user } = await registered(d);
    const originalHash = (await d.users.findById(user.id))?.passwordHash;
    // An account from before recovery codes: no hash on file.
    await d.users.create({
      id: "legacy",
      handle: "Legacy",
      handleKey: "legacy",
      passwordHash: "hash-of:whatever",
    });
    const attempts = [
      { handle: "Alice", recoveryCode: "WRONG-CODE" },
      { handle: "Nobody", recoveryCode: "CODE1-AAAAA-BBBBB-CCCCC" },
      { handle: "Legacy", recoveryCode: "CODE1-AAAAA-BBBBB-CCCCC" },
    ];
    for (const attempt of attempts) {
      await expect(
        resetPassword(d, { ...attempt, newPassword: "long enough pw" }),
      ).rejects.toBeInstanceOf(InvalidRecoveryCodeError);
    }
    // None of those changed the real account.
    const stored = await d.users.findById(user.id);
    expect(stored?.passwordHash).toBe(originalHash);
  });

  it("rejects a too-short new password before touching anything", async () => {
    const d = deps();
    const { recoveryCode } = await registered(d);
    await expect(
      resetPassword(d, { handle: "Alice", recoveryCode, newPassword: "short" }),
    ).rejects.toBeInstanceOf(ValidationError);
    // The code is still good.
    await expect(
      resetPassword(d, {
        handle: "Alice",
        recoveryCode,
        newPassword: "long enough pw",
      }),
    ).resolves.toBeDefined();
  });

  it("issueRecoveryCode needs the password and replaces the old code", async () => {
    const d = deps();
    const { user, recoveryCode: first } = await registered(d);

    await expect(
      issueRecoveryCode(d, user, "wrong password"),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const { recoveryCode: second } = await issueRecoveryCode(d, user, PASSWORD);
    expect(second).not.toBe(first);
    await expect(
      resetPassword(d, {
        handle: "Alice",
        recoveryCode: first,
        newPassword: "long enough pw",
      }),
    ).rejects.toBeInstanceOf(InvalidRecoveryCodeError);
    await expect(
      resetPassword(d, {
        handle: "Alice",
        recoveryCode: second,
        newPassword: "long enough pw",
      }),
    ).resolves.toBeDefined();
  });
});
