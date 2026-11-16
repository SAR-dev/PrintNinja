import { createHash } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { purgeExpiredSessions } from "../../src/domain/auth/index.js";
import { testConfig } from "../helpers.js";
import {
  realDeps,
  startTestDatabase,
  truncateAll,
  type TestStack,
} from "./db.js";

// Ported auth characterization tests (server-legacy/src/main.rs, the B3
// family). v1 ran on SQLite behind axum; these run the same behaviours
// against the v2 service on a real database. Deliberate v2 changes are
// asserted, not glossed over:
// - register answers 201 (was 200) and the body gains expires_at;
// - a taken handle is 409 handle_taken (was 400);
// - the throttle is the configured rate limiter (10 per 300 s by
//   IP+handle), not the in-memory 5-per-minute struct;
// - created_at is timestamptz rendered as RFC 3339 with Z.

let stack: TestStack;
let app: FastifyInstance;

beforeAll(async () => {
  stack = await startTestDatabase();
}, 180_000);

afterAll(async () => {
  await stack?.stop();
});

beforeEach(async () => {
  await truncateAll(stack.db);
  app = await buildApp({ config: testConfig(), deps: realDeps(stack.db) });
});

afterEach(async () => {
  await app?.close();
});

interface AuthBody {
  token: string;
  expires_at: string;
  user: { id: string; handle: string; created_at: string };
}

async function register(handle: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/v2/auth/register",
    payload: { handle, password },
  });
  return {
    status: response.statusCode,
    body: response.json() as AuthBody,
    response,
  };
}

async function login(handle: string, password: string) {
  const response = await app.inject({
    method: "POST",
    url: "/v2/auth/login",
    payload: { handle, password },
  });
  return {
    status: response.statusCode,
    body: response.json() as AuthBody,
    response,
  };
}

describe("ported B3 characterization", () => {
  it("b3_register_and_login", async () => {
    const reg = await register("alice", "password123");
    expect(reg.status).toBe(201);
    expect(reg.body.token.length).toBeGreaterThan(20);
    expect(reg.body.user.handle).toBe("alice");
    expect(reg.body.user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(reg.body.user.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(new Date(reg.body.expires_at).getTime()).toBeGreaterThan(Date.now());

    const second = await login("alice", "password123");
    expect(second.status).toBe(200);
    expect(second.body.token).not.toBe(reg.body.token);
    expect(second.body.user).toEqual(reg.body.user);
  });

  it("b3_wrong_password_and_unknown_handle", async () => {
    await register("bob", "password123");

    const wrong = await login("bob", "wrongpass");
    expect(wrong.status).toBe(401);

    const unknown = await login("nobody", "password123");
    expect(unknown.status).toBe(401);

    // The same answer for both, so handles cannot be probed.
    const wrongBody = wrong.response.json() as {
      error: { code: string; message: string };
    };
    const unknownBody = unknown.response.json() as {
      error: { code: string; message: string };
    };
    expect(wrongBody.error.code).toBe("invalid_credentials");
    expect(unknownBody.error.code).toBe("invalid_credentials");
    expect(unknownBody.error.message).toBe(wrongBody.error.message);
  });

  it("b3_duplicate_handle_case_insensitive", async () => {
    const first = await register("Alice", "password123");
    expect(first.status).toBe(201);

    const second = await register("alice", "password123");
    expect(second.status).toBe(409);
    const body = second.response.json() as { error: { code: string } };
    expect(body.error.code).toBe("handle_taken");
  });

  it("b3_throttle_trips", async () => {
    // 10 attempts allowed per 300 s, the 11th is a 429.
    for (let i = 0; i < 10; i += 1) {
      const attempt = await login("throttled", "wrongpassword");
      expect(attempt.status).toBe(401);
    }
    const limited = await login("throttled", "wrongpassword");
    expect(limited.status).toBe(429);
    const body = limited.response.json() as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
    expect(limited.response.headers["retry-after"]).toBeDefined();
  });

  it("b3_token_not_in_client_build", async () => {
    const reg = await register("carol", "password123");
    expect(reg.body.token).not.toContain("carol");

    // The database holds the SHA-256 hash, never the token.
    const stored = await stack.db.session.findFirstOrThrow({
      where: { userId: reg.body.user.id },
    });
    expect(stored.tokenHash).toBe(
      createHash("sha256").update(reg.body.token, "utf8").digest("hex"),
    );
    expect(stored.tokenHash).not.toContain("carol");
  });

  it("b3_me_and_logout", async () => {
    const reg = await register("dave", "password123");
    const headers = { authorization: `Bearer ${reg.body.token}` };

    const me = await app.inject({ method: "GET", url: "/v2/auth/me", headers });
    expect(me.statusCode).toBe(200);
    const meBody = me.json() as { handle: string; created_at: string };
    expect(meBody.handle).toBe("dave");
    expect(meBody.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    const logout = await app.inject({
      method: "POST",
      url: "/v2/auth/logout",
      headers,
    });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({
      method: "GET",
      url: "/v2/auth/me",
      headers,
    });
    expect(after.statusCode).toBe(401);
    const afterBody = after.json() as { error: { code: string } };
    expect(afterBody.error.code).toBe("unauthorized");
  });
});

describe("v2 endpoint contracts", () => {
  it("rejects malformed credentials with 400 and field details", async () => {
    const bad = await register("has space", "password123");
    expect(bad.status).toBe(400);
    const body = bad.response.json() as {
      error: { code: string; details: { path: string }[] };
    };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details[0]?.path).toBe("handle");

    const short = await register("eve", "short");
    expect(short.status).toBe(400);
  });

  it("logout is idempotent and needs a well-formed header", async () => {
    const reg = await register("frank", "password123");

    // Auth responses that carry tokens are never cacheable (live token).
    const me = await app.inject({
      method: "GET",
      url: "/v2/auth/me",
      headers: { authorization: `Bearer ${reg.body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");

    const first = await app.inject({
      method: "POST",
      url: "/v2/auth/logout",
      headers: { authorization: `Bearer ${reg.body.token}` },
    });
    expect(first.statusCode).toBe(204);

    // Repeating with the now-unknown token still answers 204.
    const second = await app.inject({
      method: "POST",
      url: "/v2/auth/logout",
      headers: { authorization: `Bearer ${reg.body.token}` },
    });
    expect(second.statusCode).toBe(204);

    // A missing header is a 401, not a silent success.
    const missing = await app.inject({
      method: "POST",
      url: "/v2/auth/logout",
    });
    expect(missing.statusCode).toBe(401);
    const body = missing.json() as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("grants one 201 and one 409 for a concurrent duplicate register", async () => {
    const attempts = await Promise.allSettled([
      register("grace", "password123"),
      register("grace", "password123"),
    ]);
    const statuses = attempts.map((result) =>
      result.status === "fulfilled" ? result.value.status : "rejected",
    );
    expect(statuses.sort()).toEqual([201, 409]);
  });

  it("purges expired sessions and keeps the live ones", async () => {
    const reg = await register("henry", "password123");
    await stack.db.session.create({
      data: {
        tokenHash: "dead".repeat(16),
        userId: reg.body.user.id,
        expiresAt: new Date("2020-01-01T00:00:00Z"),
      },
    });

    expect(await purgeExpiredSessions(realDeps(stack.db))).toBe(1);

    const remaining = await stack.db.session.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.tokenHash).toBe(
      createHash("sha256").update(reg.body.token, "utf8").digest("hex"),
    );
  });
});

describe("signed-in devices", () => {
  it("labels sessions from the User-Agent and revokes one by id", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/v2/auth/register",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
      },
      payload: { handle: "ivan", password: "password123" },
    });
    expect(reg.statusCode).toBe(201);
    const t1 = (reg.json() as AuthBody).token;

    const second = await app.inject({
      method: "POST",
      url: "/v2/auth/login",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131",
      },
      payload: { handle: "ivan", password: "password123" },
    });
    expect(second.statusCode).toBe(200);
    const t2 = (second.json() as AuthBody).token;

    const list = await app.inject({
      method: "GET",
      url: "/v2/auth/sessions",
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(list.statusCode).toBe(200);
    const items = (
      list.json() as {
        items: { id: string; device_label: string; current: boolean }[];
      }
    ).items;
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.device_label).sort()).toEqual([
      "Android",
      "Windows",
    ]);
    expect(items.find((item) => item.current)?.device_label).toBe("Windows");

    const otherId = items.find((item) => !item.current)?.id ?? "";
    const revoke = await app.inject({
      method: "DELETE",
      url: `/v2/auth/sessions/${otherId}`,
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(revoke.statusCode).toBe(200);

    // The row is gone from the real database and the token is dead.
    expect(
      await stack.db.session.findFirst({ where: { publicId: otherId } }),
    ).toBeNull();
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v2/auth/me",
          headers: { authorization: `Bearer ${t1}` },
        })
      ).statusCode,
    ).toBe(401);

    // A retried revoke of the now-missing id answers 404, not 200.
    const again = await app.inject({
      method: "DELETE",
      url: `/v2/auth/sessions/${otherId}`,
      headers: { authorization: `Bearer ${t2}` },
    });
    expect(again.statusCode).toBe(404);
  });

  it("recovery code: register -> reset -> old code dead, new code works", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/v2/auth/register",
      payload: { handle: "Ivy", password: "password123" },
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.headers["cache-control"]).toBe("no-store");
    const { token, recovery_code: code } = reg.json() as {
      token: string;
      recovery_code: string;
    };
    expect(code).toMatch(/^([A-HJ-NP-Z2-9]{5}-){3}[A-HJ-NP-Z2-9]{5}$/);

    const reset = (handle: string, recovery_code: string) =>
      app.inject({
        method: "POST",
        url: "/v2/auth/reset-password",
        payload: { handle, recovery_code, new_password: "brand new pw 1" },
      });

    // Wrong code and unknown handle are the same 401.
    expect((await reset("Ivy", "AAAAA-AAAAA-AAAAA-AAAAA")).statusCode).toBe(
      401,
    );
    expect((await reset("nobody", code)).statusCode).toBe(401);

    // Right code: typed in lowercase, no dashes, any handle case.
    const ok = await reset("IVY", code.toLowerCase().replaceAll("-", ""));
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    const okBody = ok.json() as { recovery_code: string; revoked: number };
    expect(okBody.revoked).toBe(1);
    expect(okBody.recovery_code).not.toBe(code);

    // The old session is gone, the old password and old code are dead.
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v2/auth/me",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(401);
    expect((await login("Ivy", "password123")).status).toBe(401);
    expect((await reset("Ivy", code)).statusCode).toBe(401);
    expect((await login("Ivy", "brand new pw 1")).status).toBe(200);

    // The rotated code is the live one.
    expect((await reset("Ivy", okBody.recovery_code)).statusCode).toBe(200);
  });

  it("recovery code: older accounts make one in settings, needs the password", async () => {
    const reg = await register("jon", "password123");
    const headers = { authorization: `Bearer ${reg.body.token}` };

    const wrong = await app.inject({
      method: "POST",
      url: "/v2/auth/recovery-code",
      headers,
      payload: { current_password: "nope nope nope" },
    });
    // 403, not 401: a typo must not look like an expired session.
    expect(wrong.statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v2/auth/recovery-code",
          payload: { current_password: "password123" },
        })
      ).statusCode,
    ).toBe(401); // not signed in

    const made = await app.inject({
      method: "POST",
      url: "/v2/auth/recovery-code",
      headers,
      payload: { current_password: "password123" },
    });
    expect(made.statusCode).toBe(200);
    const { recovery_code } = made.json() as { recovery_code: string };

    const reset = await app.inject({
      method: "POST",
      url: "/v2/auth/reset-password",
      payload: {
        handle: "jon",
        recovery_code,
        new_password: "another new pw",
      },
    });
    expect(reset.statusCode).toBe(200);
  });
});
