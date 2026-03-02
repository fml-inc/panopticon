import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export function Sessions() {
  const navigate = useNavigate();
  const { sessionId: activeSessionId } = useParams();
  const [searchQuery, setSearchQuery] = useState("");
  const { data: sessions, isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => fetch("/api/v2/sessions").then((res) => res.json()),
  });

  // Fetch all session labels
  const { data: labelsData } = useQuery({
    queryKey: ["session-labels"],
    queryFn: async () => {
      if (!sessions?.length) return {};
      const labels: Record<string, string> = {};
      // Fetch labels for all sessions in parallel
      await Promise.all(
        sessions.map(async (s: any) => {
          try {
            const res = await fetch(`/api/v2/sessions/${s.session_id}/label`);
            const data = await res.json();
            if (data.name) labels[s.session_id] = data.name;
          } catch {}
        }),
      );
      return labels;
    },
    enabled: !!sessions?.length,
  });

  const labels = labelsData || {};

  const filteredSessions = useMemo(() => {
    if (!sessions) return [];
    if (!searchQuery) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s: any) => {
      const label = labels[s.session_id];
      return (
        s.session_id.toLowerCase().includes(q) ||
        label?.toLowerCase().includes(q)
      );
    });
  }, [sessions, searchQuery, labels]);

  if (isLoading)
    return (
      <div className="p-8 text-slate-500 font-mono text-sm animate-pulse">
        Loading sessions...
      </div>
    );

  return (
    <ScrollArea className="h-full">
      <div className="p-8 max-w-6xl mx-auto space-y-6">
        <div className="flex justify-between items-end border-b border-slate-800 pb-4">
          <div>
            <h2 className="text-2xl font-black text-white tracking-tight">
              Inbox
            </h2>
            <p className="text-slate-500 mt-1 text-sm">
              Explore sessions captured by Panopticon.
            </p>
          </div>
          <Badge
            variant="outline"
            className="text-slate-400 border-slate-700 bg-slate-900"
          >
            {filteredSessions.length} Sessions
          </Badge>
        </div>

        <div className="relative">
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by session ID or label..."
            className="pl-8 bg-slate-950 border-slate-800 text-xs"
          />
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-500" />
        </div>

        <div className="grid gap-3">
          {filteredSessions.map((s: any) => {
            const start = new Date(s.start_ms);
            const duration = Math.floor((s.end_ms - s.start_ms) / 1000);
            const isCostly = s.total_cost > 0.5;
            const label = labels[s.session_id];

            return (
              <div
                key={s.session_id}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/sessions/${s.session_id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    navigate(`/sessions/${s.session_id}`);
                }}
                className={cn(
                  "p-4 rounded-xl border cursor-pointer transition-all flex flex-col md:flex-row md:justify-between md:items-center group",
                  activeSessionId === s.session_id
                    ? "bg-slate-800 border-blue-500/50 shadow-md"
                    : "bg-slate-900/50 border-slate-800 hover:border-slate-700 hover:bg-slate-800/80",
                )}
              >
                <div className="space-y-1">
                  <div className="flex items-center space-x-3">
                    <span className="w-2 h-2 rounded-full bg-slate-700 group-hover:bg-blue-400 transition-colors"></span>
                    <span className="text-xs font-mono text-blue-400/80">
                      {String(s.session_id)}
                    </span>
                    {label && (
                      <Badge
                        variant="secondary"
                        className="text-[10px] bg-blue-950/50 text-blue-400 border-blue-900/30 px-1.5 py-0"
                      >
                        {label}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center space-x-3 text-xs text-slate-500">
                    <span>{format(start, "MMM d, HH:mm")}</span>
                    <span>•</span>
                    <span>{String(duration)}s</span>
                  </div>
                </div>

                <div className="flex items-center space-x-6 mt-4 md:mt-0">
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] uppercase font-black tracking-widest text-slate-600 mb-0.5">
                      Events
                    </span>
                    <Badge
                      variant="secondary"
                      className="font-mono bg-slate-950 text-slate-300 hover:bg-slate-950"
                    >
                      {String(s.event_count)}
                    </Badge>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="text-[10px] uppercase font-black tracking-widest text-slate-600 mb-0.5">
                      Tools
                    </span>
                    <Badge
                      variant="secondary"
                      className="font-mono bg-slate-950 text-blue-400 hover:bg-slate-950"
                    >
                      {String(s.tool_count)}
                    </Badge>
                  </div>
                  <div className="flex flex-col items-end w-20">
                    <span className="text-[10px] uppercase font-black tracking-widest text-slate-600 mb-0.5">
                      Cost
                    </span>
                    <span
                      className={cn(
                        "font-mono font-bold text-sm",
                        isCostly ? "text-red-400" : "text-green-400",
                      )}
                    >
                      ${Number(s.total_cost || 0).toFixed(4)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ScrollArea>
  );
}
