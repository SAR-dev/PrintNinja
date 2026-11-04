import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { fakeDeps, testConfig } from "./helpers.js";

describe("GET /demo/print.html", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("serves the demo page as HTML", async () => {
    app = await buildApp({ config: testConfig(), deps: fakeDeps() });
    const response = await app.inject({
      method: "GET",
      url: "/demo/print.html",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("PrintNinja");
    // The form actually targets the local API endpoints.
    expect(response.body).toContain("/v1/printers");
    expect(response.body).toContain("/v1/print");
  });
});
