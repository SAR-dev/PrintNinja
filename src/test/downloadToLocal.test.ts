import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

vi.mock("@/lib/templates/compileTemplateCss", () => ({
  compiledFields: vi.fn(async () => ({ compiled_css: "", compiled_key: "" })),
}));

const client = vi.hoisted(() => ({
  fetchRemoteTemplate: vi.fn(),
}));
vi.mock("@/lib/share/client", () => client);

import { downloadToLocal } from "@/lib/share/sync";

const REMOTE = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  name: "Label",
  body: "<p>hi</p>",
  css: "",
  readme: "",
  summary: "",
  page_w_mm: 100,
  page_h_mm: 150,
  revision: 4,
  owner_handle: "ana",
  updated_at: "2026-01-01T00:00:00Z",
};

function localRow(name: string) {
  return { id: 1, name, remote_id: null, server_id: null };
}

beforeEach(() => {
  invoke.mockReset();
  client.fetchRemoteTemplate.mockReset();
  client.fetchRemoteTemplate.mockResolvedValue(REMOTE);
});

function mockBackend(local: Array<{ id: number; name: string }>) {
  const created: Array<Record<string, unknown>> = [];
  invoke.mockImplementation(async (cmd: string, args?: any) => {
    if (cmd === "list_templates")
      return local.map((r) => ({ ...r, remote_id: null, server_id: null }));
    if (cmd === "create_template") {
      created.push(args.req);
      return { id: 9 };
    }
    if (cmd === "set_publish_info" || cmd === "update_template_origin")
      return null;
    return null;
  });
  return created;
}

describe("downloadToLocal name clashes", () => {
  it("saves under the community name when free", async () => {
    const created = mockBackend([localRow("Other")]);
    const res = await downloadToLocal(REMOTE.id, "saved", "ana");
    expect(res).toEqual({ id: 9, created: true, name: "Label" });
    expect(created[0]).toMatchObject({ name: "Label", server_id: REMOTE.id });
  });

  it("keeps the author's title verbatim on a clash: mirrors are references", async () => {
    const created = mockBackend([localRow("Label")]);
    const res = await downloadToLocal(REMOTE.id, "saved", "ana");
    expect(res).toEqual({ id: 9, created: true, name: "Label" });
    expect(created[0]).toMatchObject({
      name: "Label",
      server_id: REMOTE.id,
      kind: "saved",
    });
  });

  it("returns the existing row without creating on the same server id", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_templates")
        return [
          {
            id: 5,
            name: "Old name",
            remote_id: REMOTE.id,
            server_id: REMOTE.id,
          },
        ];
      return null;
    });
    const res = await downloadToLocal(REMOTE.id, "saved", "ana");
    expect(res).toEqual({ id: 5, created: false, name: "Old name" });
  });
});
