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
import { RotateCcw, Download, Search } from "lucide-react";

export function HistoryPage() {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">{t("history.title")}</h1>
        <Button variant="outline" size="sm">
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
              <Input placeholder={t("common.search")} className="pl-9" />
            </div>
            <Select>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder={t("history.filter_status")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.all")}</SelectItem>
                <SelectItem value="success">{t("history.success")}</SelectItem>
                <SelectItem value="failed">{t("history.failed")}</SelectItem>
                <SelectItem value="queued">{t("history.queued")}</SelectItem>
                <SelectItem value="printing">{t("history.printing")}</SelectItem>
              </SelectContent>
            </Select>
            <Select>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder={t("history.filter_printer")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.all")}</SelectItem>
                <SelectItem value="front-desk">Front Desk</SelectItem>
                <SelectItem value="kitchen">Kitchen</SelectItem>
                <SelectItem value="label-1">Label Printer 1</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* History Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Template</TableHead>
                <TableHead>Printer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[
                { time: "2 min ago", template: "Receipt 80mm", printer: "Front Desk", status: "success", duration: "1.2s", source: "ui" },
                { time: "5 min ago", template: "Receipt 80mm", printer: "Kitchen", status: "success", duration: "0.8s", source: "api" },
                { time: "10 min ago", template: "Label 4x6", printer: "Label Printer 1", status: "failed", duration: "—", source: "batch" },
                { time: "15 min ago", template: "Invoice A4", printer: "Office Laser", status: "success", duration: "2.1s", source: "ui" },
                { time: "20 min ago", template: "Receipt 80mm", printer: "Front Desk", status: "success", duration: "1.0s", source: "deeplink" },
              ].map((job, i) => (
                <TableRow key={i}>
                  <TableCell className="text-muted-foreground">{job.time}</TableCell>
                  <TableCell className="font-medium">{job.template}</TableCell>
                  <TableCell>{job.printer}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        job.status === "success"
                          ? "success"
                          : job.status === "failed"
                            ? "destructive"
                            : "secondary"
                      }
                    >
                      {job.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{job.duration}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{job.source}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button variant="ghost" size="sm">
                        <RotateCcw className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
