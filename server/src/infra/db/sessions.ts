import type {
  SessionRecord,
  SessionRepository,
  UserRecord,
} from "../../domain/ports.js";
import type { DbClient } from "./client.js";

export function createSessionRepository(db: DbClient): SessionRepository {
  return {
    async create(input: {
      tokenHash: string;
      userId: string;
      expiresAt: Date;
      deviceLabel: string;
    }): Promise<SessionRecord> {
      const session = await db.session.create({ data: input });
      return toRecord(session);
    },

    async findWithUser(
      tokenHash: string,
    ): Promise<{ session: SessionRecord; user: UserRecord } | null> {
      const session = await db.session.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      if (!session) {
        return null;
      }
      return { session: toRecord(session), user: toUserRecord(session.user) };
    },

    async deleteByTokenHash(tokenHash: string): Promise<void> {
      await db.session.deleteMany({ where: { tokenHash } });
    },

    async deleteExpired(now: Date): Promise<number> {
      const result = await db.session.deleteMany({
        where: { expiresAt: { lte: now } },
      });
      return result.count;
    },

    async deleteOthersForUser(
      userId: string,
      exceptTokenHash: string,
    ): Promise<number> {
      const result = await db.session.deleteMany({
        where: { userId, tokenHash: { not: exceptTokenHash } },
      });
      return result.count;
    },

    async deleteOldestForUser(
      userId: string,
      keepNewest: number,
    ): Promise<number> {
      const rows = await db.session.findMany({
        where: { userId },
        orderBy: [{ createdAt: "desc" }, { tokenHash: "desc" }],
        select: { tokenHash: true },
      });
      const surplus = rows.slice(Math.max(keepNewest, 0));
      if (surplus.length === 0) {
        return 0;
      }
      const result = await db.session.deleteMany({
        where: {
          tokenHash: { in: surplus.map((row) => row.tokenHash) },
        },
      });
      return result.count;
    },

    async listForUser(userId: string): Promise<SessionRecord[]> {
      const rows = await db.session.findMany({
        where: { userId },
        orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
      });
      return rows.map(toRecord);
    },

    async deleteByPublicId(userId: string, publicId: string): Promise<boolean> {
      const result = await db.session.deleteMany({
        where: { userId, publicId },
      });
      return result.count > 0;
    },

    async touch(tokenHash: string, lastUsedAt: Date): Promise<void> {
      await db.session.updateMany({
        where: { tokenHash },
        data: { lastUsedAt },
      });
    },
  };
}

function toRecord(session: {
  tokenHash: string;
  publicId: string;
  userId: string;
  deviceLabel: string;
  lastUsedAt: Date;
  createdAt: Date;
  expiresAt: Date;
}): SessionRecord {
  return {
    tokenHash: session.tokenHash,
    publicId: session.publicId,
    userId: session.userId,
    deviceLabel: session.deviceLabel,
    lastUsedAt: session.lastUsedAt,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

function toUserRecord(user: {
  id: string;
  handle: string;
  handleKey: string;
  passwordHash: string;
  createdAt: Date;
}): UserRecord {
  return {
    id: user.id,
    handle: user.handle,
    handleKey: user.handleKey,
    passwordHash: user.passwordHash,
    createdAt: user.createdAt,
  };
}
