import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { NotFoundError } from "../../domain/errors.js";

/**
 * The share service's root page: a short, bilingual introduction to the
 * project for anyone who opens the service URL in a browser. It is a
 * static file, read per request (like the demo page) so edits need no
 * rebuild. On Vercel the same file ships in public/.
 */
export async function rootRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", { schema: { hide: true } }, async (_request, reply) => {
    let html: string;
    try {
      html = await readFile(
        path.join(process.cwd(), "public", "index.html"),
        "utf8",
      );
    } catch {
      throw new NotFoundError("Landing page not found");
    }
    return reply.type("text/html; charset=utf-8").send(html);
  });
}
