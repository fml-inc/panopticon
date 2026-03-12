import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutGrid, RefreshCw, Trash2 } from "lucide-react";
import { parseAsInteger, useQueryState } from "nuqs";
import { useCallback, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { WidgetRenderer } from "@/components/WidgetRenderer";
import type { Widget, WidgetData } from "@/types/widget";

export function Dashboard() {
  const queryClient = useQueryClient();
  const [refreshSec] = useQueryState("refresh", parseAsInteger);
  const refreshInterval = refreshSec ? refreshSec * 1000 : undefined;

  const { data: widgets = [], isLoading } = useQuery<Widget[]>({
    queryKey: ["widgets", "active"],
    queryFn: () => fetch("/api/v2/widgets?status=active").then((r) => r.json()),
    refetchInterval: refreshInterval,
  });

  const widgetDataQueries = useQueries({
    queries: widgets.map((w) => ({
      queryKey: ["widget-data", w.id],
      queryFn: (): Promise<WidgetData> =>
        fetch(`/api/v2/widgets/${w.id}/data`).then((r) => r.json()),
      refetchInterval: refreshInterval,
    })),
  });

  // Map widget ID -> query result for stable lookup regardless of order
  const widgetDataMap = useMemo(() => {
    const map = new Map<string, (typeof widgetDataQueries)[number]>();
    widgets.forEach((w, i) => {
      if (widgetDataQueries[i]) map.set(w.id, widgetDataQueries[i]);
    });
    return map;
  }, [widgets, widgetDataQueries]);

  // Group widgets by group_name — null group rendered last as "General"
  const widgetGroups = useMemo(() => {
    const groups = new Map<string, Widget[]>();
    for (const w of widgets) {
      const key = w.group_name ?? "";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(w);
    }
    // Sort: named groups first (alphabetical), then the unnamed group
    const sorted = new Map<string, Widget[]>();
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === "") return 1;
      if (b === "") return -1;
      return a.localeCompare(b);
    });
    for (const k of keys) sorted.set(k, groups.get(k)!);
    return sorted;
  }, [widgets]);

  const deleteWidget = useCallback(
    async (id: string) => {
      await fetch(`/api/v2/widgets/${id}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["widgets"] });
    },
    [queryClient],
  );

  const refreshWidget = useCallback(
    (id: string) => {
      queryClient.invalidateQueries({ queryKey: ["widget-data", id] });
    },
    [queryClient],
  );

  if (isLoading)
    return (
      <div className="p-8 text-slate-500 font-mono text-sm animate-pulse">
        Loading dashboard...
      </div>
    );

  if (widgets.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-8 h-full">
        <div className="w-16 h-16 rounded-2xl bg-slate-800/50 border border-slate-700 flex items-center justify-center mb-6">
          <LayoutGrid className="w-8 h-8 text-slate-500" />
        </div>
        <h2 className="text-2xl font-black text-white tracking-tight">
          No Widgets Yet
        </h2>
        <p className="text-slate-500 mt-2 max-w-md text-sm">
          Use the AI assistant to create dashboard widgets. Try asking: "Show me
          cost by day as a chart"
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 md:p-8 max-w-7xl mx-auto space-y-6">
        <div className="flex justify-between items-end border-b border-slate-800 pb-4">
          <div>
            <h2 className="text-2xl font-black text-white tracking-tight">
              Dashboard
            </h2>
            <p className="text-slate-500 mt-1 text-sm">Dashboard widgets</p>
          </div>
          <Badge
            variant="outline"
            className="text-slate-400 border-slate-700 bg-slate-900"
          >
            {widgets.length} widgets
          </Badge>
        </div>

        {[...widgetGroups.entries()].map(([groupKey, groupWidgets]) => (
          <div key={groupKey || "__general"} className="space-y-3">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider">
                {groupKey || "General"}
              </h3>
              <Badge
                variant="outline"
                className="text-[9px] text-slate-500 border-slate-700"
              >
                {groupWidgets.length}
              </Badge>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {groupWidgets.map((widget) => {
                const query = widgetDataMap.get(widget.id);
                const span =
                  widget.type === "table"
                    ? "md:col-span-2 xl:col-span-3"
                    : widget.type === "chart"
                      ? "md:col-span-2"
                      : "";

                return (
                  <div
                    key={widget.id}
                    className={`${span} bg-slate-900/50 border border-slate-800 rounded-xl overflow-hidden`}
                  >
                    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800/50">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-bold text-white">
                          {widget.title}
                        </h3>
                        <Badge
                          variant="secondary"
                          className="text-[9px] bg-slate-800 text-slate-400"
                        >
                          {widget.type}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-slate-500 hover:text-white"
                          onClick={() => refreshWidget(widget.id)}
                        >
                          <RefreshCw
                            className={`w-3.5 h-3.5 ${query?.isRefetching ? "animate-spin" : ""}`}
                          />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-slate-500 hover:text-red-400"
                          onClick={() => deleteWidget(widget.id)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                    <WidgetRenderer
                      widget={widget}
                      data={query?.data}
                      isLoading={query?.isLoading ?? true}
                      error={query?.error as Error | null}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
