import { memo } from "react";
import type { KpiConfig, WidgetData } from "@/types/widget";

interface KpiWidgetProps {
  data: WidgetData;
  config: KpiConfig;
}

export const KpiWidget = memo(function KpiWidget({
  data,
  config,
}: KpiWidgetProps) {
  const row = data.rows[0];
  if (!row) return <div className="text-slate-500 text-sm p-4">No data</div>;

  const valueKey = config.valueKey || data.columns[0];
  const rawValue = row[valueKey];

  let formatted: string;
  if (config.format === "currency") {
    formatted = `$${Number(rawValue).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  } else if (config.format === "percent") {
    formatted = `${(Number(rawValue) * 100).toFixed(1)}%`;
  } else {
    formatted = Number(rawValue).toLocaleString();
  }

  if (config.prefix) formatted = config.prefix + formatted;
  if (config.suffix) formatted = formatted + config.suffix;

  return (
    <div className="flex flex-col items-center justify-center h-full p-6">
      <div className="text-4xl font-black text-white tabular-nums">
        {formatted}
      </div>
      {data.columns.length > 1 && (
        <div className="text-sm text-slate-400 mt-2">
          {Object.entries(row)
            .filter(([k]) => k !== valueKey)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ")}
        </div>
      )}
    </div>
  );
});
