import {
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  QuotaExceededError,
  RevisionConflictError,
  RevisionRequiredError,
  ValidationError,
} from "./errors.js";
import type {
  ProfileRepository,
  ProfileView,
  ProfileWrite,
} from "./libraryPorts.js";
import { toPage, type Page } from "./pagination.js";

/** Mirror the schema char caps in bytes: multibyte input must not pass. */
export const PRINTER_NAME_MAX_BYTES = 100;
export const SETTINGS_JSON_MAX_BYTES = 65_536;
/** Per-user row cap on create, like FONTS_PER_USER_MAX: one buggy or
 * hostile client cannot grow printer_profiles without bound. Updates
 * never count, so existing rows stay editable at the cap. */
export const PROFILES_PER_USER_MAX = 500;

export interface PutProfileInput {
  id: string;
  templateId: string;
  printerName: string;
  settingsJson?: string;
  ifRevision?: number;
}

export interface PutProfileResult {
  profile: ProfileView;
  /** 201 when created, 200 when updated or replayed. */
  status: 201 | 200;
  /** True when a stale if_revision matched identical content and
   * nothing was written. */
  replayed: boolean;
}

function checkWrite(input: PutProfileInput): {
  printerName: string;
  settingsJson: string;
} {
  // Details paths use the wire names (template_id, printer_name,
  // settings_json), not the domain's camelCase, so API clients can map
  // them onto the request body they sent.
  if (!input.templateId) {
    throw new ValidationError("templateId required", [
      { path: "template_id", message: "Required" },
    ]);
  }
  // Printer names match case-insensitively (question 20): the key is
  // stored lowercase so "E2E Label Printer" and "e2e label printer"
  // address the same profile.
  const printerName = (input.printerName ?? "").trim().toLowerCase();
  if (printerName.length === 0) {
    throw new ValidationError("printerName required", [
      { path: "printer_name", message: "Required" },
    ]);
  }
  if (Buffer.byteLength(printerName, "utf8") > PRINTER_NAME_MAX_BYTES) {
    throw new PayloadTooLargeError([
      {
        path: "printer_name",
        message: `Over the ${PRINTER_NAME_MAX_BYTES} byte cap`,
      },
    ]);
  }
  const settingsJson = input.settingsJson ?? "{}";
  if (Buffer.byteLength(settingsJson, "utf8") > SETTINGS_JSON_MAX_BYTES) {
    throw new PayloadTooLargeError([
      {
        path: "settings_json",
        message: `Over the ${SETTINGS_JSON_MAX_BYTES} byte cap`,
      },
    ]);
  }
  try {
    JSON.parse(settingsJson);
  } catch {
    throw new ValidationError("settings_json is not valid JSON", [
      { path: "settings_json", message: "Must be valid JSON" },
    ]);
  }
  return { printerName, settingsJson };
}

/**
 * Creates or updates a printer profile by client UUID, keyed by template
 * and (lowercased) printer name. Same revision contract as templates:
 * 428 without if_revision on update, 409 on stale revisions unless the
 * content is identical (replayed).
 */
export async function putProfile(
  repos: { profiles: ProfileRepository },
  input: PutProfileInput,
  ownerId: string,
): Promise<PutProfileResult> {
  const { printerName, settingsJson } = checkWrite(input);
  const write: ProfileWrite = {
    id: input.id,
    ownerId,
    templateId: input.templateId,
    printerName,
    settingsJson,
  };
  const existing = await repos.profiles.findById(input.id);
  if (!existing) {
    const count = await repos.profiles.countByOwner(ownerId);
    if (count >= PROFILES_PER_USER_MAX) {
      throw new QuotaExceededError(
        `at most ${PROFILES_PER_USER_MAX} profiles per user`,
      );
    }
    const profile = await repos.profiles.create(write);
    return { profile, status: 201, replayed: false };
  }
  if (existing.ownerId !== ownerId) {
    throw new ForbiddenError();
  }
  if (input.ifRevision === undefined) {
    throw new RevisionRequiredError();
  }
  if (input.ifRevision !== existing.revision) {
    if (
      existing.settingsJson === settingsJson &&
      existing.templateId === input.templateId &&
      existing.printerName === printerName
    ) {
      return { profile: existing, status: 200, replayed: true };
    }
    throw new RevisionConflictError(existing.revision);
  }
  const profile = await repos.profiles.update(write, input.ifRevision);
  return { profile, status: 200, replayed: false };
}

export async function deleteProfile(
  repos: { profiles: ProfileRepository },
  id: string,
  ownerId: string,
): Promise<void> {
  const existing = await repos.profiles.findById(id);
  if (!existing) {
    throw new NotFoundError();
  }
  if (existing.ownerId !== ownerId) {
    throw new ForbiddenError();
  }
  await repos.profiles.deleteWithTombstone(id);
}

/** Reads one of the owner's printer profiles. Another owner's row is a
 * 403, not a 404, so existence never leaks. */
export async function getProfile(
  repos: { profiles: ProfileRepository },
  id: string,
  ownerId: string,
): Promise<ProfileView> {
  const existing = await repos.profiles.findById(id);
  if (!existing) {
    throw new NotFoundError();
  }
  if (existing.ownerId !== ownerId) {
    throw new ForbiddenError();
  }
  return existing;
}

/** The owner's profiles, newest change first (id breaks ties), paged. */
export async function listProfiles(
  repos: { profiles: ProfileRepository },
  ownerId: string,
  query: { page: number; pageSize: number },
): Promise<Page<ProfileView>> {
  const rows = (await repos.profiles.listByOwner(ownerId)).sort(
    (a, b) =>
      b.updatedAt.getTime() - a.updatedAt.getTime() || a.id.localeCompare(b.id),
  );
  const start = (query.page - 1) * query.pageSize;
  return toPage(rows.slice(start, start + query.pageSize), rows.length, query);
}
