export interface Widget {
  id: string;
  type: "chart" | "table" | "kpi" | "markdown";
  title: string;
  query: string;
  config: WidgetConfig;
  position: number;
  group_name: string | null;
  status: "active" | "pending";
  chat_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface WidgetData {
  columns: string[];
  rows: Record<string, any>[];
}

export interface ChartConfig {
  chartType?: "bar" | "line" | "area";
  xKey?: string;
  yKeys?: string[];
  colors?: string[];
}

export interface TableConfig {
  pageSize?: number;
}

export interface KpiConfig {
  format?: "number" | "currency" | "percent";
  prefix?: string;
  suffix?: string;
  valueKey?: string;
}

export interface MarkdownConfig {
  template?: string;
}

export type WidgetConfig =
  | ChartConfig
  | TableConfig
  | KpiConfig
  | MarkdownConfig;
