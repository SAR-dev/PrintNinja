import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RotateCcw, Download, Search, Trash2, Eye } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useHistoryStore, type HistoryJob } from "@/lib/store/historyStore";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

const STATUS_VARIANTS: Record<string, "success" | "destructive" | "secondary" | "warning"> = {
  success: "success",
  failed: "destructive",
  queued: "secondary",
  printing: "warning",
  cancelled: "secondary",
};

export function HistoryPage() {
  const { t } = useTranslation();
  const store = useHistoryStore();

  const filteredJobs = store.jobs.filter((job) => {
    if (store.filter.status !== "all" && job.status !== store.filter.status) return false;
    if (store.filter.printer !== "all" && job.printer_id?.toString() !== store.filter.printer) return false;
    if (store.filter.source !== "all" && job.source !== store.filter.source) return false;
    if (store.filter.isTest !== null && job.is_test !== store.filter.isTest) return false;
    if (store.filter.search) {
      const q = store.filter.search.toLowerCase();
      const match = job.source_url?.toLowerCase().includes(q) ||
        job.error?.toLowerCase().includes(q) ||
        job.id.toString().includes(q);
      if (!match) return false;
    }
    return true;
  });

  const handleReprint = (job: HistoryJob) => {
    toast.success(`Reprinting job #${job.id}`);
  };

  const handleRetry = (job: HistoryJob) => {
    toast.success(`Retrying job #${job.id}`);
  };

  const handleDelete = async (job: HistoryJob) => {
    try {
      await invoke("delete_job", { id: job.id });
      store.setJobs(store.jobs.filter((j) => j.id !== job.id));
      toast.success(`Deleted job #${job.id}`);
    } catch (e) {
      toast.error(`Failed: ${e}`);
    }
  };

  const handleExportCsv = () => {
    const headers = ["ID", "Status", "Source", "Printer", "Duration", "Error"];
    const rows = filteredJobs.map((j) => [
      j.id,
      j.status,
      j.source,
      j.printer_id,
      j.duration_ms,
      j.error || "",
    ]);
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "printninja-history.csv";
    a.click();
    toast.success("Exported to CSV");
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{t("history.title")}</h1>
        <Button variant="outline" size="sm" onClick={handleExportCsv}>
          <Download className="h-4 w-4" />
          {t("history.export_csv")}
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t("common.search")}
                className="pl-9"
                value={store.filter.search}
                onChange={(e) => store.setFilter({ search: e.target.value })}
              />
            </div>
            <Select value={store.filter.status} onValueChange={(v) => store.setFilter({ status: v })}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder={t("history.filter_status")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.all")}</SelectItem>
                <SelectItem value="success">{t("history.success")}</SelectItem>
                <SelectItem value="failed">{t("history.failed")}</SelectItem>
                <SelectItem value="queued">{t("history.queued")}</SelectItem>
                <SelectItem value="printing">{t("history.printing")}</SelectItem>
                <SelectItem value="cancelled">{t("history.cancelled")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={store.filter.source} onValueChange={(v) => store.setFilter({ source: v })}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder={t("history.source")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.all")}</SelectItem>
                <SelectItem value="ui">UI</SelectItem>
                <SelectItem value="api">API</SelectItem>
                <SelectItem value="deeplink">Deep Link</SelectItem>
                <SelectItem value="batch">Batch</SelectItem>
                <SelectItem value="test">Test</SelectItem>
              </SelectContent>
            </Select>
            <Select value={store.filter.printer} onValueChange={(v) => store.setFilter({ printer: v })}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder={t("history.filter_printer")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.all")}</SelectItem>
                <SelectItem value="1">Front Desk</SelectItem>
                <SelectItem value="2">Kitchen</SelectItem>
                <SelectItem value="3">Label Printer 1</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={store.clearFilter}>
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* History Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Printer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Version</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredJobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                    No print jobs yet. Print something to see it here.
                  </TableCell>
                </TableRow>
              ) : (
                filteredJobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="text-muted-foreground">#{job.id}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {job.finished_at || job.started_at || "—"}
                    </TableCell>
                    <TableCell className="font-medium">
                      {job.template_id ? `Template ${job.template_id}` : "—"}
                    </TableCell>
                    <TableCell>{job.printer_id ? `Printer ${job.printer_id}` : "—"}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANTS[job.status] || "secondary"}>
                        {job.status}
                      </Badge>
                    </TableCell>
                    <TableCell>{job.duration_ms ? `${job.duration_ms}ms` : "—"}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{job.source}</Badge>
                    </TableCell>
                    <TableCell>
                      {job.template_version_id ? `v${job.template_version_id}` : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => store.setSelectedJob(job)}>
                          <Eye className="h-3 w-3" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleReprint(job)}>
                          <RotateCcw className="h-3 w-3" />
                        </Button>
                        {job.status === "failed" && (
                          <Button variant="ghost" size="sm" onClick={() => handleRetry(job)}>
                            <RotateCcw className="h-3 w-3" />
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(job)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Job Detail Dialog */}
      <Dialog open={!!store.selectedJob} onOpenChange={() => store.setSelectedJob(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Job #{store.selectedJob?.id}</DialogTitle>
          </DialogHeader>
          {store.selectedJob && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <Badge variant={STATUS_VARIANTS[store.selectedJob.status]}>
                    {store.selectedJob.status}
                  </Badge>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Source</Label>
                  <Badge variant="outline">{store.selectedJob.source}</Badge>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Printer</Label>
                  <p className="text-sm">{store.selectedJob.printer_id || "—"}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Duration</Label>
                  <p className="text-sm">{store.selectedJob.duration_ms ? `${store.selectedJob.duration_ms}ms` : "—"}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Template Version</Label>
                  <p className="text-sm">{store.selectedJob.template_version_id ? `v${store.selectedJob.template_version_id}` : "—"}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Copies</Label>
                  <p className="text-sm">{store.selectedJob.copies}</p>
                </div>
              </div>
              {store.selectedJob.error && (
                <div>
                  <Label className="text-xs text-muted-foreground">Error</Label>
                  <p className="text-sm text-red-600 dark:text-red-400">{store.selectedJob.error}</p>
                </div>
              )}
              {store.selectedJob.source_url && (
                <div>
                  <Label className="text-xs text-muted-foreground">Source URL</Label>
                  <p className="text-sm font-mono break-all">{store.selectedJob.source_url}</p>
                </div>
              )}
              {store.selectedJob.settings_json && (
                <div>
                  <Label className="text-xs text-muted-foreground">Settings</Label>
                  <pre className="text-xs bg-muted p-2 rounded-md overflow-auto max-h-40">
                    {JSON.stringify(JSON.parse(store.selectedJob.settings_json), null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
