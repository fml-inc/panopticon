import { memo, useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartConfig, WidgetData } from "@/types/widget";

const PALETTE = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];

interface ChartWidgetProps {
  data: WidgetData;
  config: ChartConfig;
}

export const ChartWidget = memo(function ChartWidget({
  data,
  config,
}: ChartWidgetProps) {
  const xKey = config.xKey || data.columns[0];
  const yKeys = useMemo(() => {
    if (config.yKeys?.length) return config.yKeys;
    return data.columns.filter((c) => c !== xKey);
  }, [config.yKeys, data.columns, xKey]);

  const chartType = config.chartType || "bar";

  // Single-yKey bar chart → color each bar by category (x-axis value)
  const isCategoricalBar = chartType === "bar" && yKeys.length === 1;

  // For multi-series, use config colors (one per series). For categorical, always use full palette.
  const seriesColors = config.colors?.length ? config.colors : PALETTE;
  const categoryColors = PALETTE;

  const commonProps = {
    data: data.rows,
    margin: { top: 8, right: 16, left: 0, bottom: 0 },
  };

  const tooltipStyle = {
    background: "hsl(222, 47%, 11%)",
    border: "1px solid hsl(217, 33%, 17%)",
    borderRadius: "8px",
    fontSize: "11px",
    color: "hsl(210, 40%, 98%)",
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
  };

  const legendStyle = { fontSize: "10px", paddingTop: "8px" };
  const legendFormatter = (value: string) => (
    <span style={{ color: "hsl(215, 20%, 65%)" }}>{value}</span>
  );

  // For categorical bars, build a custom legend payload (each bar = its own entry)
  const categoricalPayload = useMemo(() => {
    if (!isCategoricalBar) return null;
    return data.rows.map((row, i) => ({
      value: String(row[xKey]),
      type: "square" as const,
      color: categoryColors[i % categoryColors.length],
    }));
  }, [isCategoricalBar, data.rows, xKey]);

  const sharedAxes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="hsl(217, 33%, 17%)" />
      <XAxis
        dataKey={xKey}
        tick={{ fill: "hsl(215, 20%, 65%)", fontSize: 10 }}
        axisLine={{ stroke: "hsl(217, 33%, 17%)" }}
        tickLine={false}
      />
      <YAxis
        tick={{ fill: "hsl(215, 20%, 65%)", fontSize: 10 }}
        axisLine={false}
        tickLine={false}
        width={50}
      />
      <Tooltip
        contentStyle={tooltipStyle}
        cursor={{ fill: "rgba(100, 116, 139, 0.1)" }}
      />
    </>
  );

  return (
    <div className="w-full h-72 p-4">
      <ResponsiveContainer width="100%" height="100%">
        {chartType === "line" ? (
          <LineChart {...commonProps}>
            {sharedAxes}
            <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
            {yKeys.map((key, i) => (
              <Line
                key={key}
                dataKey={key}
                name={key}
                type="monotone"
                stroke={seriesColors[i % seriesColors.length]}
                strokeWidth={2}
                dot={{ r: 3, fill: seriesColors[i % seriesColors.length] }}
                activeDot={{ r: 5, strokeWidth: 2 }}
              />
            ))}
          </LineChart>
        ) : chartType === "area" ? (
          <AreaChart {...commonProps}>
            {sharedAxes}
            <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
            {yKeys.map((key, i) => (
              <Area
                key={key}
                dataKey={key}
                name={key}
                type="monotone"
                fill={seriesColors[i % seriesColors.length]}
                fillOpacity={0.2}
                stroke={seriesColors[i % seriesColors.length]}
                strokeWidth={2}
              />
            ))}
          </AreaChart>
        ) : (
          <BarChart {...commonProps}>
            {sharedAxes}
            {categoricalPayload ? (
              <Legend
                wrapperStyle={legendStyle}
                formatter={legendFormatter}
                payload={categoricalPayload}
              />
            ) : (
              <Legend wrapperStyle={legendStyle} formatter={legendFormatter} />
            )}
            {yKeys.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                name={key}
                fill={seriesColors[i % seriesColors.length]}
                radius={[4, 4, 0, 0]}
              >
                {isCategoricalBar &&
                  data.rows.map((row, j) => (
                    <Cell
                      key={`cell-${row[data.columns[0]] ?? j}`}
                      fill={categoryColors[j % categoryColors.length]}
                    />
                  ))}
              </Bar>
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
});
