import {
  NotFoundError,
  RevisionConflictError,
  RevisionRequiredError,
  TemplateNameTakenError,
} from "../../domain/errors.js";
import type {
  PageQuery,
  PublishedQuery,
  TemplateRepository,
  TemplateView,
  TemplateWrite,
  VersionWrite,
} from "../../domain/templatePorts.js";
import { toPage } from "../../domain/pagination.js";
import type { DbClient } from "./client.js";
import type { Prisma } from "./generated/index.js";
import {
  toTemplateSummaryView,
  toTemplateView,
  toVersionSummaryView,
  toVersionView,
} from "./views.js";

/**
 * One repository per aggregate (REFACTORING.md section 5). Mutations run
 * inside a transaction that first takes the user's sequence number —
 * the row lock on user_sync serializes one user's writes, so revision
 * checks after the bump see committed state and concurrent updates
 * cannot lose each other. The domain decides (reads, replay, version
 * or not); this module makes the write atomic.
 */
export function createTemplateRepository(db: DbClient): TemplateRepository {
  return {
    async findById(id: string): Promise<TemplateView | null> {
      const template = await db.template.findUnique({
        where: { id },
        include: {
          owner: { select: { handle: true } },
          _count: { select: { versions: true } },
        },
      });
      return template && toView(template);
    },

    async create(
      input: TemplateWrite,
      version: VersionWrite,
    ): Promise<TemplateView> {
      try {
        const template = await db.$transaction(async (tx) => {
          const seq = await bumpSeq(tx, input.ownerId);
          const created = await tx.template.create({
            data: {
              id: input.id,
              ownerId: input.ownerId,
              name: input.name,
              summary: input.summary,
              pageWMm: input.pageWMm,
              pageHMm: input.pageHMm,
              language: input.language,
              body: input.body,
              css: input.css,
              readme: input.readme,
              createdAt: input.createdAt ?? new Date(),
              updatedAt: input.updatedAt ?? new Date(),
              changeSeq: seq,
            },
            include: {
              owner: { select: { handle: true } },
              _count: { select: { versions: true } },
            },
          });
          await tx.templateVersion.create({
            data: {
              templateId: created.id,
              versionNo: 1,
              body: input.body,
              css: input.css,
              createdBy: version.createdBy,
              ...(version.label !== undefined ? { label: version.label } : {}),
              ...(version.note !== undefined ? { note: version.note } : {}),
            },
          });
          await pruneAutosaves(tx, created.id);
          return { ...created, _count: { versions: 1 } };
        });
        return toView(template);
      } catch (error: unknown) {
        if (isUniqueViolation(error)) {
          // Two unique keys can fire: the id (a retried create racing
          // the first; the row now exists, so the caller retries as an
          // update) or the owner's name.
          const row = await db.template.findUnique({
            where: { id: input.id },
            select: { id: true },
          });
          throw row
            ? new RevisionRequiredError()
            : new TemplateNameTakenError();
        }
        throw error;
      }
    },

    async update(
      input: TemplateWrite,
      expectedRevision: number,
      version: VersionWrite | null,
    ): Promise<TemplateView> {
      const template = await db.$transaction(async (tx) => {
        // Bump first: the user_sync row lock serializes this user's
        // writers, so the revision read below is never stale.
        const seq = await bumpSeq(tx, input.ownerId);
        const current = await tx.template.findUnique({
          where: { id: input.id },
        });
        if (!current) {
          throw new NotFoundError();
        }
        if (current.revision !== expectedRevision) {
          throw new RevisionConflictError(current.revision);
        }
        let updated;
        try {
          updated = await tx.template.update({
            where: { id: input.id },
            data: {
              name: input.name,
              summary: input.summary,
              pageWMm: input.pageWMm,
              pageHMm: input.pageHMm,
              language: input.language,
              body: input.body,
              css: input.css,
              readme: input.readme,
              revision: version ? current.revision + 1 : current.revision,
              changeSeq: seq,
            },
            include: {
              owner: { select: { handle: true } },
              _count: { select: { versions: true } },
            },
          });
        } catch (error: unknown) {
          // The id cannot change here, so the only unique key that can
          // fire is (owner, name). Throwing rolls the sequence bump back.
          if (isUniqueViolation(error)) {
            throw new TemplateNameTakenError();
          }
          throw error;
        }
        // Every successful write moves the savers' mirrors — content edits
        // and metadata-only PUTs alike (mirrors keep the author's title
        // verbatim). Same transaction: a pull can never see the content
        // without the stamps.
        await stampSavers(tx, input.id, current.ownerId);
        if (version) {
          const max = await tx.templateVersion.aggregate({
            where: { templateId: input.id },
            _max: { versionNo: true },
          });
          await tx.templateVersion.create({
            data: {
              templateId: input.id,
              versionNo: (max._max.versionNo ?? 0) + 1,
              body: input.body,
              css: input.css,
              createdBy: version.createdBy,
              ...(version.label !== undefined ? { label: version.label } : {}),
              ...(version.note !== undefined ? { note: version.note } : {}),
            },
          });
          await pruneAutosaves(tx, input.id);
          return {
            ...updated,
            _count: { versions: updated._count.versions + 1 },
          };
        }
        return updated;
      });
      return toView(template);
    },

    async setPublished(
      id: string,
      publishedAt: Date | null,
    ): Promise<TemplateView | null> {
      const template = await db.$transaction(async (tx) => {
        const current = await tx.template.findUnique({ where: { id } });
        if (!current) {
          return null;
        }
        const seq = await bumpSeq(tx, current.ownerId);
        // The first publish time is kept across unpublish cycles:
        // republishing restores it instead of minting a new one.
        // Unpublishing clears publishedAt but never the memory.
        const data =
          publishedAt === null
            ? { publishedAt: null as Date | null, changeSeq: seq }
            : {
                publishedAt: current.firstPublishedAt ?? publishedAt,
                firstPublishedAt: current.firstPublishedAt ?? publishedAt,
                changeSeq: seq,
              };
        const updated = await tx.template.update({
          where: { id },
          data,
          include: {
            owner: { select: { handle: true } },
            _count: { select: { versions: true } },
          },
        });
        // A (re)publish re-emits every saver's mirror. An unpublish emits
        // nothing: the mirrors stay put, printable but withdrawn (the
        // Saved tab badges them live), until a republish refreshes them.
        if (publishedAt !== null) {
          await stampSavers(tx, id, current.ownerId);
        }
        return updated;
      });
      return template && toView(template);
    },

    async deleteWithTombstone(id: string): Promise<{ ownerId: string } | null> {
      return db.$transaction(async (tx) => {
        const current = await tx.template.findUnique({ where: { id } });
        if (!current) {
          return null;
        }
        const seq = await bumpSeq(tx, current.ownerId);
        await tx.tombstone.create({
          data: {
            userId: current.ownerId,
            seq,
            entity: "template",
            entityKey: id,
          },
        });
        // No saver tombstones: mirrors of a deleted template stay put
        // like withdrawn ones (the manifest still reports the delete),
        // and the save rows survive with them.
        await tx.template.delete({ where: { id } });
        return { ownerId: current.ownerId };
      });
    },

    async listByOwner(ownerId: string, query: PageQuery) {
      const where = { ownerId };
      const [total, rows] = await Promise.all([
        db.template.count({ where }),
        db.template.findMany({
          where,
          include: {
            owner: { select: { handle: true } },
            _count: { select: { versions: true } },
          },
          orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);
      return toPage(rows.map(toSummary), total, query);
    },

    async listPublished(query: PublishedQuery) {
      const q = query.q?.trim();
      const where = {
        publishedAt: { not: null },
        ...(q
          ? {
              OR: [
                { name: { contains: q } },
                { summary: { contains: q } },
                {
                  owner: {
                    handle: { contains: q },
                  },
                },
              ],
            }
          : {}),
      };
      const orderBy =
        query.sort === "used"
          ? [
              { useCount: "desc" as const },
              { updatedAt: "desc" as const },
              { id: "asc" as const },
            ]
          : query.sort === "name"
            ? [{ name: "asc" as const }, { id: "asc" as const }]
            : [{ updatedAt: "desc" as const }, { id: "asc" as const }];
      const [total, rows] = await Promise.all([
        db.template.count({ where }),
        db.template.findMany({
          where,
          include: {
            owner: { select: { handle: true } },
            _count: { select: { versions: true } },
          },
          orderBy,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);
      return toPage(rows.map(toSummary), total, query);
    },

    async incrementUseCount(id: string, by: number): Promise<boolean> {
      const result = await db.template.updateMany({
        where: { id, publishedAt: { not: null } },
        data: { useCount: { increment: by } },
      });
      return result.count > 0;
    },

    async getDailyUse(
      userId: string,
      templateId: string,
      day: Date,
    ): Promise<number> {
      const row = await db.templateUseDaily.findUnique({
        where: { userId_templateId_day: { userId, templateId, day } },
      });
      return row?.count ?? 0;
    },

    async addDailyUse(
      userId: string,
      templateId: string,
      day: Date,
      by: number,
    ): Promise<number> {
      const row = await db.templateUseDaily.upsert({
        where: { userId_templateId_day: { userId, templateId, day } },
        update: { count: { increment: by } },
        create: { userId, templateId, day, count: by },
      });
      return row.count;
    },

    async listVersions(templateId: string, query: PageQuery) {
      const where = { templateId };
      const [total, rows] = await Promise.all([
        db.templateVersion.count({ where }),
        db.templateVersion.findMany({
          where,
          orderBy: [{ versionNo: "desc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
      ]);
      return toPage(rows.map(toVersionSummary), total, query);
    },

    async findVersion(templateId: string, versionNo: number) {
      const row = await db.templateVersion.findUnique({
        where: { templateId_versionNo: { templateId, versionNo } },
      });
      return row && toVersion(row);
    },

    async deleteVersion(templateId: string, versionNo: number) {
      const max = await db.templateVersion.aggregate({
        where: { templateId },
        _max: { versionNo: true },
      });
      if (max._max.versionNo === null) {
        return "missing";
      }
      if (max._max.versionNo === versionNo) {
        return "newest";
      }
      const deleted = await db.templateVersion.deleteMany({
        where: { templateId, versionNo },
      });
      return deleted.count > 0 ? "deleted" : "missing";
    },
  };
}

/** Savers of one template, in stable order, excluding the author. Fan-out
 * locks one user_sync row per saver; a fixed order keeps concurrent
 * author edits from deadlocking on each other's locks. The author is
 * excluded: their own feed already carries the template, and a saver
 * tombstone in their stream would delete their own copy locally. */
async function saverIds(
  tx: Prisma.TransactionClient,
  templateId: string,
  ownerId: string,
): Promise<string[]> {
  const rows = await tx.savedTemplate.findMany({
    where: { templateId, userId: { not: ownerId } },
    select: { userId: true },
    orderBy: { userId: "asc" },
  });
  return rows.map((r) => r.userId);
}

/** An author edit or (re)publish moves every saver's mirror: stamp their
 * rows with fresh sequence numbers so the next pull re-emits the copy. */
async function stampSavers(
  tx: Prisma.TransactionClient,
  templateId: string,
  ownerId: string,
): Promise<void> {
  for (const userId of await saverIds(tx, templateId, ownerId)) {
    const seq = await bumpSeq(tx, userId);
    await tx.savedTemplate.update({
      where: { userId_templateId: { userId, templateId } },
      data: { changeSeq: seq },
    });
  }
}

/** Next sequence number for the user, row-locked. The user_sync row is
 * created at registration; upsert self-heals an import gap instead of
 * failing every write, handing the same first number (2n) either way.
 * Exported for the saved repository: saves and saver fan-out live in
 * the saver's sequence space, not the author's. */
export async function bumpSeq(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<bigint> {
  const row = await tx.userSync.upsert({
    where: { userId },
    update: { nextSeq: { increment: 1n } },
    create: { userId, nextSeq: 2n },
  });
  return row.nextSeq;
}

/** Autosaves beyond the newest 50 per template are deleted when a new
 * version is added; manual and restore versions are never pruned. */
async function pruneAutosaves(
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<void> {
  const count = await tx.templateVersion.count({
    where: { templateId, createdBy: "autosave" },
  });
  if (count > 50) {
    const oldest = await tx.templateVersion.findMany({
      where: { templateId, createdBy: "autosave" },
      orderBy: { versionNo: "asc" },
      take: count - 50,
      select: { versionNo: true },
    });
    await tx.templateVersion.deleteMany({
      where: { templateId, versionNo: { in: oldest.map((v) => v.versionNo) } },
    });
  }
}

/** P2002 is Prisma's stable unique-violation code. Structural check:
 * the generated client re-exports its error class as a type alias,
 * which cannot narrow. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

// Row mapping lives in ./views.js (shared with saved and sync).
const toView = toTemplateView;
const toSummary = toTemplateSummaryView;
const toVersion = toVersionView;
const toVersionSummary = toVersionSummaryView;
