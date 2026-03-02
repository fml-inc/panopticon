import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  ChevronRight,
  Loader2,
  Pencil,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { InlineEventDetails } from "@/components/InlineEventDetails";
import { LazyMarkdown } from "@/components/LazyMarkdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseAnalyzeStream } from "@/lib/parse-stream";
import { cn } from "@/lib/utils";

// TODO(@tanstack/react-hotkeys): Replace manual keyboard handlers with:
//   useHotkey({ key: 'ArrowDown' }, () => navigateNext())
//   useHotkey({ key: 'ArrowUp' }, () => navigatePrev())
//   useHotkey({ key: 'j' }, () => navigateNext())
//   useHotkey({ key: 'k' }, () => navigatePrev())
//   useHotkey({ key: 'Escape' }, () => navigate(`/sessions/${sessionId}`))
//   useHotkey({ key: 'Enter' }, () => toggleExpand())

const PAGE_SIZE = 100;

export function TimelinePanel() {
  const { sessionId, source, eventId } = useParams();
  const navigate = useNavigate();
  const [localSearch, setLocalSearch] = useQueryState(
    "filter",
    parseAsString.withDefault(""),
  );
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [isEditingLabel, setIsEditingLabel] = useState(false);
  const [labelInput, setLabelInput] = useState("");
  const labelInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const activeEventId = source && eventId ? `${source}:${eventId}` : null;
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const { data: labelData } = useQuery({
    queryKey: ["session-label", sessionId],
    queryFn: () =>
      fetch(`/api/v2/sessions/${sessionId}/label`).then((res) => res.json()),
    enabled: !!sessionId,
  });

  const sessionLabel = labelData?.name || null;

  const startEditingLabel = useCallback(() => {
    setLabelInput(sessionLabel || "");
    setIsEditingLabel(true);
    setTimeout(() => labelInputRef.current?.focus(), 0);
  }, [sessionLabel]);

  const saveLabel = useCallback(async () => {
    if (!sessionId) return;
    const name = labelInput.trim();
    if (name) {
      await fetch(`/api/v2/sessions/${sessionId}/label`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    } else {
      await fetch(`/api/v2/sessions/${sessionId}/label`, { method: "DELETE" });
    }
    setIsEditingLabel(false);
    queryClient.invalidateQueries({ queryKey: ["session-label", sessionId] });
    queryClient.invalidateQueries({ queryKey: ["session-labels"] });
  }, [sessionId, labelInput, queryClient]);

  const cancelEditLabel = useCallback(() => {
    setIsEditingLabel(false);
  }, []);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: ["timeline", sessionId],
      queryFn: ({ pageParam = 0 }) =>
        fetch(
          `/api/v2/sessions/${sessionId}?limit=${PAGE_SIZE}&offset=${pageParam}`,
        ).then((res) => res.json()),
      initialPageParam: 0,
      getNextPageParam: (lastPage, allPages) => {
        const loaded = allPages.reduce(
          (sum, p) => sum + (p.rows?.length || 0),
          0,
        );
        return loaded < lastPage.total ? loaded : undefined;
      },
      enabled: !!sessionId,
    });

  const allRows = useMemo(
    () => data?.pages.flatMap((p) => p.rows ?? []) ?? [],
    [data],
  );
  const totalCount = data?.pages[0]?.total ?? 0;

  const filteredRows = useMemo(() => {
    if (!localSearch) return allRows;
    const q = localSearch.toLowerCase();
    return allRows.filter(
      (ev: any) =>
        ev.event_type?.toLowerCase().includes(q) ||
        ev.tool_name?.toLowerCase().includes(q) ||
        ev.payload?.toLowerCase().includes(q),
    );
  }, [allRows, localSearch]);

  const virtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 80,
    overscan: 10,
  });

  // Fetch next page when scrolling near end
  useEffect(() => {
    const lastItem = virtualizer.getVirtualItems().at(-1);
    if (!lastItem) return;
    if (
      lastItem.index >= allRows.length - 20 &&
      hasNextPage &&
      !isFetchingNextPage
    ) {
      fetchNextPage();
    }
  }, [
    hasNextPage,
    isFetchingNextPage,
    allRows.length,
    fetchNextPage,
    virtualizer,
  ]);

  // Scroll active event into view
  useEffect(() => {
    if (!activeEventId) return;
    const index = filteredRows.findIndex(
      (ev: any) => `${ev.source}:${ev.id}` === activeEventId,
    );
    if (index >= 0) {
      virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
    }
  }, [activeEventId, filteredRows, virtualizer]);

  const toggleExpand = useCallback(
    (key: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setExpandedEvents((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      // Re-measure after expand/collapse
      requestAnimationFrame(() => virtualizer.measure());
    },
    [virtualizer],
  );

  // AI Session Summary
  const summarizeSession = useCallback(async () => {
    if (summaryLoading || summaryText) return;
    setSummaryLoading(true);
    setSummaryText("");

    try {
      const eventSummary = filteredRows
        .slice(0, 50)
        .map(
          (ev: any) =>
            `[${ev.event_type}] ${ev.tool_name || ""} ${ev.payload?.substring(0, 100) || ""}`,
        )
        .join("\n");

      const prompt = `Summarize this Claude Code / Gemini CLI session in 2-3 paragraphs. Focus on what was accomplished, key tools used, and any errors or notable patterns.\n\nSession ${sessionId} events:\n${eventSummary}`;

      const response = await fetch("/api/v2/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, model: "haiku" }),
      });

      if (!response.ok) throw new Error("Summary failed");

      for await (const event of parseAnalyzeStream(response)) {
        if (event.type === "text") {
          setSummaryText((prev) => (prev || "") + event.content);
        }
      }
    } catch (e: any) {
      setSummaryText(`**Error:** ${e.message}`);
    } finally {
      setSummaryLoading(false);
    }
  }, [filteredRows, sessionId, summaryLoading, summaryText]);

  // Keyboard navigation (Arrow keys + vim j/k, Enter to expand, Escape to deselect)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isNav =
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === "j" ||
        e.key === "k";
      if (!isNav && e.key !== "Escape" && e.key !== "Enter") return;
      if (
        (e.target as HTMLElement)?.tagName === "INPUT" ||
        (e.target as HTMLElement)?.tagName === "TEXTAREA"
      )
        return;

      e.preventDefault();

      if (e.key === "Escape") {
        navigate(`/sessions/${sessionId}`);
        return;
      }

      if (e.key === "Enter" && activeEventId) {
        setExpandedEvents((prev) => {
          const next = new Set(prev);
          if (next.has(activeEventId)) next.delete(activeEventId);
          else next.add(activeEventId);
          return next;
        });
        requestAnimationFrame(() => virtualizer.measure());
        return;
      }

      if (filteredRows.length === 0) return;

      const currentIndex = activeEventId
        ? filteredRows.findIndex(
            (ev: any) => `${ev.source}:${ev.id}` === activeEventId,
          )
        : -1;

      const isDown = e.key === "ArrowDown" || e.key === "j";
      let nextIndex: number;
      if (isDown) {
        nextIndex =
          currentIndex === -1
            ? 0
            : Math.min(filteredRows.length - 1, currentIndex + 1);
      } else {
        nextIndex =
          currentIndex <= 0 ? filteredRows.length - 1 : currentIndex - 1;
      }

      const nextEvent = filteredRows[nextIndex];
      if (nextEvent) {
        navigate(
          `/sessions/${sessionId}/events/${nextEvent.source}/${nextEvent.id}`,
        );
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filteredRows, activeEventId, sessionId, navigate, virtualizer]);

  if (!sessionId) return null;

  return (
    <div className="h-full flex flex-col bg-slate-950 border-l border-slate-800">
      <div className="p-4 border-b border-slate-800 bg-slate-900/50">
        <div className="flex items-center justify-between mb-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-bold text-white shrink-0">Timeline</h3>
              <span className="text-slate-500 font-mono text-xs">
                {sessionId.substring(0, 8)}
              </span>
              <span className="text-slate-600 font-mono text-xs">
                ({filteredRows.length}
                {totalCount > allRows.length ? ` / ${totalCount}` : ""})
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-1">
              {isEditingLabel ? (
                <div className="flex items-center gap-1">
                  <Input
                    ref={labelInputRef}
                    value={labelInput}
                    onChange={(e) => setLabelInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveLabel();
                      if (e.key === "Escape") cancelEditLabel();
                    }}
                    onBlur={saveLabel}
                    placeholder="Name this session..."
                    className="h-6 text-xs bg-slate-950 border-slate-700 w-40"
                  />
                  <button
                    type="button"
                    onClick={saveLabel}
                    className="text-green-400 hover:text-green-300"
                  >
                    <Check className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={cancelEditLabel}
                    className="text-slate-500 hover:text-slate-300"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : sessionLabel ? (
                <button
                  type="button"
                  onClick={startEditingLabel}
                  className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 group"
                >
                  <span>{sessionLabel}</span>
                  <Pencil className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startEditingLabel}
                  className="flex items-center gap-1 text-[10px] text-slate-600 hover:text-slate-400"
                >
                  <Pencil className="w-2.5 h-2.5" />
                  <span>Name session</span>
                </button>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={summarizeSession}
            disabled={summaryLoading}
            className="h-7 px-2 text-xs text-slate-400 hover:text-blue-400"
          >
            {summaryLoading ? (
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
            ) : (
              <Sparkles className="w-3 h-3 mr-1" />
            )}
            Summarize
          </Button>
        </div>
        <div className="relative">
          <Input
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            placeholder="Filter timeline..."
            className="h-8 pl-8 bg-slate-950 border-slate-800 text-xs"
          />
          <Search className="w-3 h-3 absolute left-2.5 top-2.5 text-slate-500" />
        </div>
      </div>

      {/* AI Summary */}
      {(summaryLoading || summaryText !== null) && (
        <div className="border-b border-slate-800 bg-slate-900/30 max-h-48 overflow-auto">
          <div className="px-4 py-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-widest font-black text-blue-400">
              AI Summary
            </span>
            {summaryText !== null && (
              <button
                type="button"
                onClick={() => {
                  setSummaryText(null);
                  setSummaryLoading(false);
                }}
                className="text-[10px] text-slate-500 hover:text-slate-300"
              >
                dismiss
              </button>
            )}
          </div>
          {summaryLoading && !summaryText ? (
            <div className="flex items-center gap-2 px-4 pb-3 text-xs text-slate-500">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Analyzing session...</span>
            </div>
          ) : summaryText ? (
            <LazyMarkdown
              content={summaryText}
              className="prose prose-invert prose-xs max-w-none px-4 pb-3 text-[11px]"
            />
          ) : null}
        </div>
      )}

      <div ref={scrollContainerRef} className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="text-slate-500 font-mono text-sm animate-pulse">
            Loading timeline...
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="text-slate-600 font-mono text-sm text-center py-8">
            No events match filter.
          </div>
        ) : (
          <>
            <div
              style={{
                height: `${virtualizer.getTotalSize()}px`,
                position: "relative",
              }}
            >
              {/* Timeline vertical line */}
              <div className="absolute left-[11px] top-0 bottom-0 w-0.5 bg-gradient-to-b from-transparent via-slate-800 to-transparent" />

              {virtualizer.getVirtualItems().map((virtualRow) => {
                const ev = filteredRows[virtualRow.index];
                const isUser = ev.event_type === "UserPromptSubmit";
                const isTool = ev.event_type.includes("Tool");
                const isError = ev.severity_text === "ERROR";
                const isActive = activeEventId === `${ev.source}:${ev.id}`;
                const eventKey = `${ev.source}:${ev.id}`;
                const isExpanded = expandedEvents.has(eventKey);

                return (
                  <div
                    key={eventKey}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    className="pb-2"
                  >
                    <div className="relative flex items-start gap-3 group">
                      {/* Timeline Node */}
                      <div
                        className={cn(
                          "w-6 h-6 rounded-full border-4 border-slate-950 shrink-0 shadow-sm z-10 transition-transform group-hover:scale-110 mt-1",
                          isUser
                            ? "bg-indigo-500"
                            : isTool
                              ? "bg-amber-500"
                              : isError
                                ? "bg-red-500"
                                : "bg-blue-500",
                          isActive && "ring-4 ring-blue-500/50",
                        )}
                      />

                      {/* Event Card */}
                      <div className="flex-1">
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() =>
                            navigate(
                              `/sessions/${sessionId}/events/${ev.source}/${ev.id}`,
                            )
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ")
                              navigate(
                                `/sessions/${sessionId}/events/${ev.source}/${ev.id}`,
                              );
                          }}
                          className={cn(
                            "p-3 rounded-xl border transition-all cursor-pointer",
                            isActive
                              ? "bg-slate-800 border-slate-600 shadow-md"
                              : "bg-slate-900/80 border-slate-800 hover:bg-slate-800/50",
                          )}
                        >
                          <div className="flex justify-between items-center mb-1.5">
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={(e) => toggleExpand(eventKey, e)}
                                className="text-slate-500 hover:text-slate-200 transition-transform"
                              >
                                <ChevronRight
                                  className={cn(
                                    "w-3.5 h-3.5 transition-transform",
                                    isExpanded && "rotate-90",
                                  )}
                                />
                              </button>
                              <span className="font-bold text-slate-200 text-xs">
                                {String(ev.event_type || "Log")}
                              </span>
                            </div>
                            <span className="text-[9px] text-slate-500 font-mono">
                              {ev.timestamp_ms
                                ? new Date(ev.timestamp_ms).toLocaleTimeString(
                                    [],
                                    {
                                      hour12: false,
                                      hour: "2-digit",
                                      minute: "2-digit",
                                      second: "2-digit",
                                    },
                                  )
                                : ""}
                            </span>
                          </div>
                          {ev.tool_name && (
                            <div className="mb-1">
                              <Badge
                                variant="secondary"
                                className="text-[9px] bg-blue-950/50 text-blue-400 border-blue-900/30 px-1 py-0"
                              >
                                {String(ev.tool_name)}
                              </Badge>
                            </div>
                          )}
                          {ev.payload && !isExpanded && (
                            <div className="text-[10px] text-slate-400 font-mono truncate opacity-70">
                              {typeof ev.payload === "string"
                                ? ev.payload
                                : JSON.stringify(ev.payload)}
                            </div>
                          )}
                        </div>

                        {/* Inline expansion */}
                        {isExpanded && (
                          <InlineEventDetails
                            source={ev.source}
                            eventId={ev.id}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {isFetchingNextPage && (
              <div className="flex items-center gap-2 py-4 text-slate-500 text-xs font-mono justify-center">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading more events...
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
