import { useQuery } from "@tanstack/react-query";
import { parseAsString, useQueryState } from "nuqs";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

function formatDate(ms: number) {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function SearchResults() {
  const [q] = useQueryState("q", parseAsString.withDefault(""));
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["search", q],
    queryFn: () =>
      fetch(`/api/v2/search?q=${encodeURIComponent(q)}`).then((res) =>
        res.json(),
      ),
    enabled: !!q,
  });

  if (!q) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
        <div className="text-6xl mb-4 opacity-20">&#128269;</div>
        <h2 className="text-2xl font-black text-white tracking-tight">
          Search Stream
        </h2>
        <p className="text-slate-500 mt-2 max-w-md">
          Query hook payloads, tool inputs, and OTel logs across all history.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-8 text-slate-500 font-mono text-sm animate-pulse">
        Searching...
      </div>
    );
  }

  const rows = data?.rows || [];

  return (
    <ScrollArea className="h-full">
      <div className="p-8 max-w-6xl mx-auto space-y-6">
        <div className="flex justify-between items-end border-b border-slate-800 pb-4">
          <div>
            <h2 className="text-2xl font-black text-white tracking-tight">
              Search Results
            </h2>
            <p className="text-slate-500 mt-1 text-sm">
              Matches for <span className="text-blue-400 font-mono">"{q}"</span>
            </p>
          </div>
          <Badge
            variant="outline"
            className="text-slate-400 border-slate-700 bg-slate-900"
          >
            {rows.length} results
          </Badge>
        </div>

        {rows.length === 0 ? (
          <div className="text-center py-20 text-slate-600 font-mono italic">
            No matches found.
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((ev: any) => {
              const isHook = ev.source === "hook";
              return (
                <div
                  key={`${ev.source}:${ev.id}`}
                  role="button"
                  tabIndex={0}
                  onClick={() =>
                    navigate(
                      `/sessions/${ev.session_id}/events/${ev.source}/${ev.id}`,
                    )
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ")
                      navigate(
                        `/sessions/${ev.session_id}/events/${ev.source}/${ev.id}`,
                      );
                  }}
                  className="bg-slate-900/50 hover:bg-slate-800/80 border border-slate-800 hover:border-slate-700 p-4 rounded-xl cursor-pointer group transition-all"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center space-x-3">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          isHook
                            ? "bg-blue-950/30 text-blue-400 border-blue-900"
                            : "bg-amber-950/30 text-amber-400 border-amber-900",
                        )}
                      >
                        {isHook ? "Hook" : "OTel"}
                      </Badge>
                      <span className="text-sm font-bold text-slate-200 uppercase tracking-tight">
                        {ev.event_type}
                      </span>
                      {ev.tool_name && (
                        <Badge
                          variant="secondary"
                          className="text-[9px] bg-blue-950/50 text-blue-400 border-blue-900/30 px-1.5 py-0"
                        >
                          {ev.tool_name}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center space-x-3">
                      <span className="text-[10px] font-mono text-slate-600 bg-slate-950 px-2 py-1 rounded border border-slate-800">
                        {ev.session_id?.substring(0, 8)}
                      </span>
                      <span className="text-xs font-mono text-slate-500">
                        {formatDate(ev.timestamp_ms)}
                      </span>
                    </div>
                  </div>
                  {ev.payload && (
                    <div className="text-xs text-slate-400 font-mono bg-slate-950/50 p-3 rounded-lg border border-slate-800/50 truncate">
                      {typeof ev.payload === "string"
                        ? ev.payload.substring(0, 300)
                        : JSON.stringify(ev.payload).substring(0, 300)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
