import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { NotFoundError } from "../../domain/errors.js";

/**
 * Serves the API demo page — a plain-HTML mirror of the app's Print page
 * that talks to the local REST API. No auth, no state: it is a static file
 * read once per request.
 *
 * On Vercel the same file ships in public/ and the afterFiles rewrite lets
 * the static copy win, so this route only ever answers locally.
 */
export async function demoRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/demo/print.html",
    { schema: { hide: true } },
    async (_request, reply) => {
      let html: string;
      try {
        html = await readFile(
          path.join(process.cwd(), "public", "demo", "print.html"),
          "utf8",
        );
      } catch {
        throw new NotFoundError("Demo page not found");
      }
      return reply.type("text/html; charset=utf-8").send(html);
    },
  );
}
