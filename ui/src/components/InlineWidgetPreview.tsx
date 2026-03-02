import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WidgetRenderer } from "@/components/WidgetRenderer";
import type { Widget, WidgetData } from "@/types/widget";

export function InlineWidgetPreview({ widgetId }: { widgetId: string }) {
  const queryClient = useQueryClient();
  const [promoted, setPromoted] = useState(false);
  const [showGroupInput, setShowGroupInput] = useState(false);
  const [groupName, setGroupName] = useState("");

  const { data: widget, isLoading: widgetLoading } = useQuery<Widget>({
    queryKey: ["widget", widgetId],
    queryFn: () => fetch(`/api/v2/widgets/${widgetId}`).then((r) => r.json()),
  });

  const {
    data: widgetData,
    isLoading: dataLoading,
    error,
  } = useQuery<WidgetData>({
    queryKey: ["widget-data", widgetId],
    queryFn: () =>
      fetch(`/api/v2/widgets/${widgetId}/data`).then((r) => r.json()),
    enabled: !!widget,
  });

  const handlePromote = useCallback(async () => {
    await fetch(`/api/v2/widgets/${widgetId}/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_name: groupName || undefined }),
    });
    setPromoted(true);
    setShowGroupInput(false);
    queryClient.invalidateQueries({ queryKey: ["widget", widgetId] });
    queryClient.invalidateQueries({ queryKey: ["widgets"] });
  }, [widgetId, groupName, queryClient]);

  if (widgetLoading) {
    return (
      <div className="my-2 p-4 rounded-lg border border-slate-700 bg-slate-950/50 flex items-center gap-2 text-slate-500 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading preview...
      </div>
    );
  }

  if (!widget) return null;

  const isActive = promoted || widget.status === "active";

  return (
    <div className="my-2 rounded-xl border border-slate-700 bg-slate-900/50 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800/50">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-bold text-white">{widget.title}</h4>
          <Badge
            variant="secondary"
            className="text-[9px] bg-slate-800 text-slate-400"
          >
            {widget.type}
          </Badge>
          {isActive ? (
            <Badge className="text-[9px] bg-emerald-900/50 text-emerald-400 border border-emerald-800">
              On Dashboard
            </Badge>
          ) : (
            <Badge className="text-[9px] bg-amber-900/50 text-amber-400 border border-amber-800">
              Preview
            </Badge>
          )}
        </div>
        {!isActive && (
          <div className="flex items-center gap-2">
            {showGroupInput && (
              <Input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="Group name (optional)"
                className="h-7 w-40 text-xs bg-slate-950 border-slate-700"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handlePromote();
                }}
              />
            )}
            <Button
              size="sm"
              className="h-7 text-xs bg-blue-600 hover:bg-blue-700 px-3"
              onClick={() => {
                if (showGroupInput) {
                  handlePromote();
                } else {
                  setShowGroupInput(true);
                }
              }}
            >
              <Plus className="w-3 h-3 mr-1" />
              Add to Dashboard
            </Button>
          </div>
        )}
        {isActive && !promoted && null}
        {promoted && (
          <div className="flex items-center gap-1 text-emerald-400 text-xs">
            <Check className="w-3 h-3" />
            Added
          </div>
        )}
      </div>
      <WidgetRenderer
        widget={widget}
        data={widgetData}
        isLoading={dataLoading}
        error={error as Error | null}
      />
    </div>
  );
}
