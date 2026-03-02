import { memo } from "react";
import type {
  ChartConfig,
  KpiConfig,
  MarkdownConfig,
  TableConfig,
  Widget,
  WidgetData,
} from "@/types/widget";
import { ChartWidget } from "./widgets/ChartWidget";
import { KpiWidget } from "./widgets/KpiWidget";
import { MarkdownWidget } from "./widgets/MarkdownWidget";
import { TableWidget } from "./widgets/TableWidget";

interface WidgetRendererProps {
  widget: Widget;
  data: WidgetData | undefined;
  isLoading: boolean;
  error: Error | null;
}

export const WidgetRenderer = memo(function WidgetRenderer({
  widget,
  data,
  isLoading,
  error,
}: WidgetRendererProps) {
  if (isLoading)
    return <div className="animate-pulse h-32 bg-slate-800/50 rounded" />;
  if (error)
    return (
      <div className="text-red-400 text-xs font-mono p-4">
        Error: {error.message}
      </div>
    );
  if (!data) return <div className="text-slate-500 text-sm p-4">No data</div>;

  switch (widget.type) {
    case "kpi":
      return <KpiWidget data={data} config={widget.config as KpiConfig} />;
    case "table":
      return <TableWidget data={data} config={widget.config as TableConfig} />;
    case "chart":
      return <ChartWidget data={data} config={widget.config as ChartConfig} />;
    case "markdown":
      return (
        <MarkdownWidget data={data} config={widget.config as MarkdownConfig} />
      );
    default:
      return (
        <div className="text-slate-500 text-sm p-4">
          Unknown widget type: {widget.type}
        </div>
      );
  }
});
