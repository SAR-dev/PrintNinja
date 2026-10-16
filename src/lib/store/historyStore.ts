import { create } from "zustand";

export interface HistoryJob {
  id: number;
  batch_id: number | null;
  record_index: number | null;
  template_id: number | null;
  template_version_id: number | null;
  printer_id: number | null;
  source: "ui" | "api" | "deeplink" | "batch" | "test";
  source_url: string | null;
  status: "queued" | "printing" | "success" | "failed" | "cancelled";
  error: string | null;
  copies: number;
  settings_json: string | null;
  rendered_html: string | null;
  idempotency_key: string | null;
  is_test: boolean;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface HistoryFilter {
  status: string;
  printer: string;
  dateFrom: string;
  dateTo: string;
  search: string;
  source: string;
  isTest: boolean | null;
}

interface HistoryState {
  jobs: HistoryJob[];
  filter: HistoryFilter;
  selectedJob: HistoryJob | null;
  retentionDays: number;
  maxRecords: number;

  setJobs: (jobs: HistoryJob[]) => void;
  setFilter: (filter: Partial<HistoryFilter>) => void;
  setSelectedJob: (job: HistoryJob | null) => void;
  setRetentionDays: (days: number) => void;
  setMaxRecords: (max: number) => void;
  clearFilter: () => void;
}

const defaultFilter: HistoryFilter = {
  status: "all",
  printer: "all",
  dateFrom: "",
  dateTo: "",
  search: "",
  source: "all",
  isTest: null,
};

export const useHistoryStore = create<HistoryState>((set) => ({
  jobs: [],
  filter: defaultFilter,
  selectedJob: null,
  retentionDays: 30,
  maxRecords: 10000,

  setJobs: (jobs) => set({ jobs }),
  setFilter: (filter) => set((state) => ({ filter: { ...state.filter, ...filter } })),
  setSelectedJob: (selectedJob) => set({ selectedJob }),
  setRetentionDays: (retentionDays) => set({ retentionDays }),
  setMaxRecords: (maxRecords) => set({ maxRecords }),
  clearFilter: () => set({ filter: defaultFilter }),
}));
