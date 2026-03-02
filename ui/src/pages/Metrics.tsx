import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Search } from "lucide-react";
import { parseAsStringLiteral, useQueryStates } from "nuqs";
import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  XAxis,
  YAxis,
} from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

type SortKey = "name" | "calls" | "success" | "failures" | "rate";
type ModelSortKey = "model" | "input" | "output" | "cache" | "total" | "cost";

const MODEL_COLORS = [
  "#3b82f6",
  "#8b5cf6",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#06b6d4",
  "#84cc16",
];

export function Metrics() {
  const [{ sort: sortKey, dir: sortDir }, setSort] = useQueryStates({
    sort: parseAsStringLiteral([
      "name",
      "calls",
      "success",
      "failures",
      "rate",
    ] as const).withDefault("calls"),
    dir: parseAsStringLiteral(["asc", "desc"] as const).withDefault("desc"),
  });
  const [toolFilter, setToolFilter] = useState("");
  const [modelSort, setModelSort] = useState<{
    key: ModelSortKey;
    dir: "asc" | "desc";
  }>({ key: "cost", dir: "desc" });

  const { data, isLoading } = useQuery({
    queryKey: ["metrics"],
    queryFn: () => fetch("/api/v2/metrics").then((res) => res.json()),
  });

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSort({ dir: sortDir === "asc" ? "desc" : "asc" });
    } else {
      setSort({ sort: key, dir: "desc" });
    }
  };

  const handleModelSort = (key: ModelSortKey) => {
    setModelSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" },
    );
  };

  const sortedStats = useMemo(() => {
    if (!data?.stats) return [];
    let filtered = data.stats;
    if (toolFilter) {
      const q = toolFilter.toLowerCase();
      filtered = filtered.filter((s: any) =>
        s.tool_name.toLowerCase().includes(q),
      );
    }
    return [...filtered].sort((a: any, b: any) => {
      let valA: any, valB: any;
      switch (sortKey) {
        case "name":
          valA = a.tool_name;
          valB = b.tool_name;
          break;
        case "calls":
          valA = a.call_count;
          valB = b.call_count;
          break;
        case "success":
          valA = a.success_count;
          valB = b.success_count;
          break;
        case "failures":
          valA = a.failure_count;
          valB = b.failure_count;
          break;
        case "rate":
          valA = a.success_count / (a.call_count || 1);
          valB = b.success_count / (b.call_count || 1);
          break;
      }
      if (valA < valB) return sortDir === "asc" ? -1 : 1;
      if (valA > valB) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [data?.stats, sortKey, sortDir, toolFilter]);

  const sortedModels = useMemo(() => {
    if (!data?.modelCosts) return [];
    return [...data.modelCosts].sort((a: any, b: any) => {
      let valA: any, valB: any;
      switch (modelSort.key) {
        case "model":
          valA = a.group_key;
          valB = b.group_key;
          break;
        case "input":
          valA = a.input_tokens;
          valB = b.input_tokens;
          break;
        case "output":
          valA = a.output_tokens;
          valB = b.output_tokens;
          break;
        case "cache":
          valA = a.cache_read_tokens || 0;
          valB = b.cache_read_tokens || 0;
          break;
        case "total":
          valA = a.total_tokens;
          valB = b.total_tokens;
          break;
        case "cost":
          valA = a.total_cost;
          valB = b.total_cost;
          break;
      }
      if (valA < valB) return modelSort.dir === "asc" ? -1 : 1;
      if (valA > valB) return modelSort.dir === "asc" ? 1 : -1;
      return 0;
    });
  }, [data?.modelCosts, modelSort]);

  if (isLoading)
    return (
      <div className="p-8 text-slate-500 font-mono text-sm animate-pulse">
        Loading metrics...
      </div>
    );

  if (!data) return null;

  const { costs } = data;
  const models: any[] = data.modelCosts || [];

  const totalCost =
    costs?.reduce((acc: number, c: any) => acc + c.total_cost, 0) || 0;
  const totalInput = models.reduce(
    (acc: number, m: any) => acc + (m.input_tokens || 0),
    0,
  );
  const totalOutput = models.reduce(
    (acc: number, m: any) => acc + (m.output_tokens || 0),
    0,
  );
  const totalCacheRead = models.reduce(
    (acc: number, m: any) => acc + (m.cache_read_tokens || 0),
    0,
  );
  const totalCacheWrite = models.reduce(
    (acc: number, m: any) => acc + (m.cache_write_tokens || 0),
    0,
  );
  const totalCalls = (data.stats || []).reduce(
    (acc: number, s: any) => acc + s.call_count,
    0,
  );
  const cacheHitRate =
    totalInput + totalCacheRead > 0
      ? Math.round((totalCacheRead / (totalInput + totalCacheRead)) * 100)
      : 0;

  const chartConfig = {
    total_cost: { label: "Cost ($)", color: "#3b82f6" },
    input_tokens: { label: "Input", color: "#3b82f6" },
    output_tokens: { label: "Output", color: "#10b981" },
    cache_read_tokens: { label: "Cache Read", color: "#8b5cf6" },
  };

  // Model cost chart data — sorted by cost desc
  const modelCostChart = [...models]
    .sort((a: any, b: any) => b.total_cost - a.total_cost)
    .map((m: any) => ({ name: m.group_key, cost: m.total_cost }));

  // Model token chart data — stacked input/output/cache
  const modelTokenChart = [...models]
    .sort(
      (a: any, b: any) =>
        b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens),
    )
    .map((m: any) => ({
      name: m.group_key,
      input_tokens: m.input_tokens || 0,
      output_tokens: m.output_tokens || 0,
      cache_read_tokens: m.cache_read_tokens || 0,
    }));

  function formatTokens(n: number): string {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  }

  function formatCost(n: number): string {
    if (n >= 1) return `$${n.toFixed(2)}`;
    if (n >= 0.01) return `$${n.toFixed(3)}`;
    return `$${n.toFixed(4)}`;
  }

  const SortIcon = ({
    column,
    current,
    dir,
  }: {
    column: string;
    current: string;
    dir: string;
  }) => {
    if (current !== column) return null;
    return dir === "asc" ? (
      <ArrowUp className="w-3 h-3 inline-block ml-1" />
    ) : (
      <ArrowDown className="w-3 h-3 inline-block ml-1" />
    );
  };

  return (
    <div className="p-8 max-w-6xl mx-auto space-y-8 h-full overflow-y-auto">
      <div>
        <h2 className="text-3xl font-black text-white tracking-tight">
          System Metrics
        </h2>
        <p className="text-slate-500 mt-1 text-sm">
          Costs, token usage, and tool reliability.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-2">
            <CardDescription className="text-[10px] uppercase font-black tracking-widest text-slate-500">
              Total Spend
            </CardDescription>
            <CardTitle className="text-3xl font-black text-blue-500">
              ${totalCost.toFixed(2)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-2">
            <CardDescription className="text-[10px] uppercase font-black tracking-widest text-slate-500">
              Input Tokens
            </CardDescription>
            <CardTitle className="text-3xl font-black text-blue-400">
              {formatTokens(totalInput)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-2">
            <CardDescription className="text-[10px] uppercase font-black tracking-widest text-slate-500">
              Output Tokens
            </CardDescription>
            <CardTitle className="text-3xl font-black text-emerald-400">
              {formatTokens(totalOutput)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-2">
            <CardDescription className="text-[10px] uppercase font-black tracking-widest text-slate-500">
              Cache Hit Rate
            </CardDescription>
            <CardTitle className="text-3xl font-black text-purple-400">
              {cacheHitRate}%
            </CardTitle>
            <p className="text-[10px] text-slate-600 mt-0.5">
              {formatTokens(totalCacheRead)} cached /{" "}
              {formatTokens(totalCacheWrite)} written
            </p>
          </CardHeader>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader className="pb-2">
            <CardDescription className="text-[10px] uppercase font-black tracking-widest text-slate-500">
              Tool Calls
            </CardDescription>
            <CardTitle className="text-3xl font-black text-white">
              {totalCalls.toLocaleString()}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Daily Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader>
            <CardTitle className="text-sm font-bold text-slate-200">
              Cost by Day
            </CardTitle>
            <CardDescription>Estimated spend in USD</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={chartConfig}
              className="min-h-[250px] w-full"
            >
              <BarChart data={costs || []}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#334155"
                  vertical={false}
                />
                <XAxis
                  dataKey="group_key"
                  stroke="#64748b"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#64748b"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value: any) => `$${value}`}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar
                  dataKey="total_cost"
                  fill="#3b82f6"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card className="bg-slate-900 border-slate-800">
          <CardHeader>
            <CardTitle className="text-sm font-bold text-slate-200">
              Token Breakdown by Day
            </CardTitle>
            <CardDescription>Input, output, and cache tokens</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={chartConfig}
              className="min-h-[250px] w-full"
            >
              <BarChart data={costs || []}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="#334155"
                  vertical={false}
                />
                <XAxis
                  dataKey="group_key"
                  stroke="#64748b"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#64748b"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(val: any) => formatTokens(val)}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Legend wrapperStyle={{ fontSize: "11px" }} />
                <Bar
                  dataKey="input_tokens"
                  stackId="tokens"
                  fill="#3b82f6"
                  radius={[0, 0, 0, 0]}
                  name="Input"
                />
                <Bar
                  dataKey="output_tokens"
                  stackId="tokens"
                  fill="#10b981"
                  radius={[0, 0, 0, 0]}
                  name="Output"
                />
                <Bar
                  dataKey="cache_read_tokens"
                  stackId="tokens"
                  fill="#8b5cf6"
                  radius={[4, 4, 0, 0]}
                  name="Cache Read"
                />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      {/* Model Charts */}
      {models.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card className="bg-slate-900 border-slate-800">
            <CardHeader>
              <CardTitle className="text-sm font-bold text-slate-200">
                Cost by Model
              </CardTitle>
              <CardDescription>Estimated spend per model</CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={chartConfig}
                className="min-h-[250px] w-full"
              >
                <BarChart
                  data={modelCostChart}
                  layout="vertical"
                  margin={{ left: 20 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#334155"
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    stroke="#64748b"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(val: any) => formatCost(val)}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    stroke="#64748b"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    width={120}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="cost" radius={[0, 4, 4, 0]} name="Cost ($)">
                    {modelCostChart.map((entry, i) => (
                      <Cell
                        key={`model-${entry.model ?? i}`}
                        fill={MODEL_COLORS[i % MODEL_COLORS.length]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>

          <Card className="bg-slate-900 border-slate-800">
            <CardHeader>
              <CardTitle className="text-sm font-bold text-slate-200">
                Token Mix by Model
              </CardTitle>
              <CardDescription>
                Input vs output vs cache per model
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={chartConfig}
                className="min-h-[250px] w-full"
              >
                <BarChart
                  data={modelTokenChart}
                  layout="vertical"
                  margin={{ left: 20 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#334155"
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    stroke="#64748b"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(val: any) => formatTokens(val)}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    stroke="#64748b"
                    fontSize={10}
                    tickLine={false}
                    axisLine={false}
                    width={120}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Legend wrapperStyle={{ fontSize: "11px" }} />
                  <Bar
                    dataKey="input_tokens"
                    stackId="tokens"
                    fill="#3b82f6"
                    name="Input"
                  />
                  <Bar
                    dataKey="output_tokens"
                    stackId="tokens"
                    fill="#10b981"
                    name="Output"
                  />
                  <Bar
                    dataKey="cache_read_tokens"
                    stackId="tokens"
                    fill="#8b5cf6"
                    radius={[0, 4, 4, 0]}
                    name="Cache Read"
                  />
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Model Breakdown Table */}
      {sortedModels.length > 0 && (
        <Card className="bg-slate-900 border-slate-800">
          <CardHeader>
            <CardTitle className="text-sm font-bold text-slate-200">
              Model Details
            </CardTitle>
            <CardDescription>Token usage and cost per model</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow className="border-slate-800 hover:bg-transparent">
                  <TableHead
                    className="font-mono text-[10px] uppercase text-slate-500 cursor-pointer hover:text-slate-200 transition-colors select-none"
                    onClick={() => handleModelSort("model")}
                  >
                    Model{" "}
                    <SortIcon
                      column="model"
                      current={modelSort.key}
                      dir={modelSort.dir}
                    />
                  </TableHead>
                  <TableHead
                    className="font-mono text-[10px] uppercase text-slate-500 text-right cursor-pointer hover:text-slate-200 transition-colors select-none"
                    onClick={() => handleModelSort("input")}
                  >
                    Input{" "}
                    <SortIcon
                      column="input"
                      current={modelSort.key}
                      dir={modelSort.dir}
                    />
                  </TableHead>
                  <TableHead
                    className="font-mono text-[10px] uppercase text-slate-500 text-right cursor-pointer hover:text-slate-200 transition-colors select-none"
                    onClick={() => handleModelSort("output")}
                  >
                    Output{" "}
                    <SortIcon
                      column="output"
                      current={modelSort.key}
                      dir={modelSort.dir}
                    />
                  </TableHead>
                  <TableHead
                    className="font-mono text-[10px] uppercase text-slate-500 text-right cursor-pointer hover:text-slate-200 transition-colors select-none"
                    onClick={() => handleModelSort("cache")}
                  >
                    Cache Read{" "}
                    <SortIcon
                      column="cache"
                      current={modelSort.key}
                      dir={modelSort.dir}
                    />
                  </TableHead>
                  <TableHead
                    className="font-mono text-[10px] uppercase text-slate-500 text-right cursor-pointer hover:text-slate-200 transition-colors select-none"
                    onClick={() => handleModelSort("total")}
                  >
                    Total{" "}
                    <SortIcon
                      column="total"
                      current={modelSort.key}
                      dir={modelSort.dir}
                    />
                  </TableHead>
                  <TableHead
                    className="font-mono text-[10px] uppercase text-slate-500 text-right cursor-pointer hover:text-slate-200 transition-colors select-none"
                    onClick={() => handleModelSort("cost")}
                  >
                    Cost{" "}
                    <SortIcon
                      column="cost"
                      current={modelSort.key}
                      dir={modelSort.dir}
                    />
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedModels.map((m: any) => {
                  const totalModelCost =
                    data.modelCosts.reduce(
                      (a: number, c: any) => a + c.total_cost,
                      0,
                    ) || 1;
                  const pct = (m.total_cost / totalModelCost) * 100;
                  return (
                    <TableRow
                      key={m.group_key}
                      className="border-slate-800 hover:bg-slate-800/50"
                    >
                      <TableCell className="font-mono text-purple-400 font-bold text-xs">
                        {m.group_key}
                      </TableCell>
                      <TableCell className="text-right font-mono text-blue-400/80 text-xs">
                        {formatTokens(m.input_tokens)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-emerald-400/80 text-xs">
                        {formatTokens(m.output_tokens)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-purple-400/60 text-xs">
                        {formatTokens(m.cache_read_tokens || 0)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-slate-300 text-xs">
                        {formatTokens(m.total_tokens)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end space-x-3">
                          <span className="text-xs font-mono font-bold text-green-400">
                            ${m.total_cost.toFixed(2)}
                          </span>
                          <div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden shrink-0">
                            <div
                              className="h-full bg-purple-500 transition-all"
                              style={{ width: `${Math.min(pct, 100)}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-slate-600 w-10 text-right">
                            {pct.toFixed(1)}%
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Tools Table */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-bold text-slate-200">
                Tool Reliability
              </CardTitle>
              <CardDescription>{sortedStats.length} tools</CardDescription>
            </div>
            <div className="relative w-48">
              <Input
                value={toolFilter}
                onChange={(e) => setToolFilter(e.target.value)}
                placeholder="Filter tools..."
                className="h-7 pl-7 bg-slate-950 border-slate-800 text-xs"
              />
              <Search className="w-3 h-3 absolute left-2.5 top-2 text-slate-500" />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead
                  className="font-mono text-[10px] uppercase text-slate-500 cursor-pointer hover:text-slate-200 transition-colors select-none"
                  onClick={() => handleSort("name")}
                >
                  Tool Name{" "}
                  <SortIcon column="name" current={sortKey} dir={sortDir} />
                </TableHead>
                <TableHead
                  className="font-mono text-[10px] uppercase text-slate-500 text-right cursor-pointer hover:text-slate-200 transition-colors select-none"
                  onClick={() => handleSort("calls")}
                >
                  Calls{" "}
                  <SortIcon column="calls" current={sortKey} dir={sortDir} />
                </TableHead>
                <TableHead
                  className="font-mono text-[10px] uppercase text-slate-500 text-right cursor-pointer hover:text-slate-200 transition-colors select-none"
                  onClick={() => handleSort("success")}
                >
                  Success{" "}
                  <SortIcon column="success" current={sortKey} dir={sortDir} />
                </TableHead>
                <TableHead
                  className="font-mono text-[10px] uppercase text-slate-500 text-right cursor-pointer hover:text-slate-200 transition-colors select-none"
                  onClick={() => handleSort("failures")}
                >
                  Failures{" "}
                  <SortIcon column="failures" current={sortKey} dir={sortDir} />
                </TableHead>
                <TableHead
                  className="font-mono text-[10px] uppercase text-slate-500 text-right cursor-pointer hover:text-slate-200 transition-colors select-none"
                  onClick={() => handleSort("rate")}
                >
                  Success Rate{" "}
                  <SortIcon column="rate" current={sortKey} dir={sortDir} />
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedStats.map((s: any) => {
                const rate = Math.round(
                  (s.success_count / (s.call_count || 1)) * 100,
                );
                return (
                  <TableRow
                    key={s.tool_name}
                    className="border-slate-800 hover:bg-slate-800/50"
                  >
                    <TableCell className="font-mono text-blue-400 font-bold text-xs">
                      {s.tool_name}
                    </TableCell>
                    <TableCell className="text-right font-mono text-slate-300 text-xs">
                      {s.call_count}
                    </TableCell>
                    <TableCell className="text-right font-mono text-green-500/80 text-xs">
                      {s.success_count}
                    </TableCell>
                    <TableCell className="text-right font-mono text-red-500/80 text-xs">
                      {s.failure_count}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end space-x-3">
                        <span className="text-xs font-mono font-bold">
                          {rate}%
                        </span>
                        <div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden shrink-0">
                          <div
                            className={cn(
                              "h-full transition-all",
                              rate > 90
                                ? "bg-green-500"
                                : rate > 50
                                  ? "bg-amber-500"
                                  : "bg-red-500",
                            )}
                            style={{ width: `${rate}%` }}
                          />
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
