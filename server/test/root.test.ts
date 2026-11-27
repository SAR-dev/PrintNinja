import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { fakeDeps, testConfig } from "./helpers.js";

describe("GET /", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("serves the bilingual project introduction as HTML", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({ method: "GET", url: "/" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    const html = response.body;
    expect(html).toContain("PrintNinja");

    // Every visible string carries both languages, and the toggle switches
    // between them. Count the pairs rather than pinning marketing copy.
    const english = html.match(/data-en=/g)?.length ?? 0;
    const japanese = html.match(/data-ja=/g)?.length ?? 0;
    expect(english).toBeGreaterThan(20);
    expect(japanese).toBe(english);
    expect(html).toContain('data-lang="ja"');
    expect(html).toContain("日本語");

    // Diagrams are inline (role=img / the route diagram), with no external
    // scripts or styles to load.
    expect(html).toContain('role="img"');
    expect(html).toContain("Route diagram:");
    expect(html).not.toContain("<script src=");
  });
});
