import { useCallback, useEffect, useState } from "react";
import { agent } from "@/lib/agent/commands";
import {
  SAMPLE_ORDER_NAME,
  type Dataset,
} from "@/components/designer/SampleDataPanel";
import { DEFAULT_MOCK_DATA } from "@/lib/templates/defaultTemplate";

/**
 * The account's single sample dataset: loaded through the agent and
 * synced like templates. The built-in fallback stands in until one is
 * stored, and a pending JSON edit (`draftDatasetJson`) is held locally
 * until Save writes it.
 */
export function useSampleDataset() {
  const [datasets, setDatasets] = useState<
    Array<Dataset & { id?: number | null }>
  >([]);

  const loadDatasets = useCallback(async () => {
    try {
      const rows = (await agent("list_datasets", {})) ?? [];
      setDatasets(
        rows.map((r) => ({ id: r.id, name: r.name, json: r.data_json })),
      );
    } catch {
      /* web mode or backend unavailable: the fallback below applies */
    }
  }, []);

  useEffect(() => {
    void loadDatasets();
  }, [loadDatasets]);

  // A completed pull lands rows after mount; reload so the new content
  // shows with no manual step.
  useEffect(() => {
    const onPulled = () => void loadDatasets();
    window.addEventListener("sync:pulled", onPulled);
    return () => window.removeEventListener("sync:pulled", onPulled);
  }, [loadDatasets]);

  // The built-in fallback stands in for the account's dataset until one
  // is stored.
  const fallbackDataset: Dataset & { id?: number | null } = {
    name: SAMPLE_ORDER_NAME,
    json: JSON.stringify(DEFAULT_MOCK_DATA, null, 2),
  };

  // The single dataset the Designer shows and edits: "Sample Order" when
  // present, otherwise the first in name order; the built-in fallback
  // when the cache holds no rows yet. Other rows stay stored and synced
  // but are not shown.
  const activeDataset: Dataset & { id?: number | null } =
    datasets.find((d) => d.name === SAMPLE_ORDER_NAME) ??
    datasets[0] ??
    fallbackDataset;

  // A pending JSON edit only. `null` means no pending change, so the
  // saved row is what the panel and the canvas see. Save writes the
  // draft to the database; discarding the edit drops it.
  const [draftDatasetJson, setDraftDatasetJson] = useState<string | null>(null);
  const workingDatasetJson = draftDatasetJson ?? activeDataset.json;
  const datasetsDirty =
    draftDatasetJson !== null && draftDatasetJson !== activeDataset.json;

  /** Write the draft JSON to the account's single dataset row: update it
   * in place when it is stored, create it under the fixed name otherwise.
   * Other rows are left alone. */
  const commitDataset = async () => {
    if (draftDatasetJson === null || draftDatasetJson === activeDataset.json) {
      setDraftDatasetJson(null);
      return;
    }
    const d = activeDataset;
    await agent("save_dataset", {
      req:
        d.id != null
          ? { id: d.id, name: d.name, data_json: draftDatasetJson }
          : { name: d.name, data_json: draftDatasetJson },
    });
    setDraftDatasetJson(null);
    await loadDatasets();
  };

  // The JSON edit dialog's draft text and open state.
  const [editJson, setEditJson] = useState("");
  const [showEditDataset, setShowEditDataset] = useState(false);

  return {
    activeDataset,
    workingDatasetJson,
    datasetsDirty,
    draftDatasetJson,
    setDraftDatasetJson,
    commitDataset,
    editJson,
    setEditJson,
    showEditDataset,
    setShowEditDataset,
  };
}
