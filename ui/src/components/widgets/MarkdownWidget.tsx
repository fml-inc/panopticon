import { memo } from "react";
import { LazyMarkdown } from "@/components/LazyMarkdown";
import type { MarkdownConfig, WidgetData } from "@/types/widget";

interface MarkdownWidgetProps {
  data: WidgetData;
  config: MarkdownConfig;
}

export const MarkdownWidget = memo(function MarkdownWidget({
  data,
  config,
}: MarkdownWidgetProps) {
  if (config.template) {
    let content = config.template;
    if (data.rows[0]) {
      for (const [key, value] of Object.entries(data.rows[0])) {
        content = content.replaceAll(`{{${key}}}`, String(value));
      }
    }
    return <LazyMarkdown content={content} />;
  }

  if (data.columns.length === 0 || data.rows.length === 0) {
    return <div className="text-slate-500 text-sm p-4">No data</div>;
  }

  const header = `| ${data.columns.join(" | ")} |`;
  const separator = `| ${data.columns.map(() => "---").join(" | ")} |`;
  const rows = data.rows.map(
    (row) => `| ${data.columns.map((c) => String(row[c] ?? "")).join(" | ")} |`,
  );

  return <LazyMarkdown content={[header, separator, ...rows].join("\n")} />;
});
