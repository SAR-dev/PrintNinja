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
    expect(response.body).toContain("PrintNinja");
    // Both languages live in the same page, switched by the toggle.
    expect(response.body).toContain('data-en="Printing that just works."');
    expect(response.body).toContain('data-ja="印刷が、ただ動きます。"');
    expect(response.body).toContain('data-lang="ja"');
    // Two inline diagrams, with no external assets to load.
    expect(response.body).toContain('aria-label="Print pipeline"');
    expect(response.body).toContain('aria-label="Phone and PC pairing"');
    expect(response.body).not.toContain("<script src=");
  });
});
