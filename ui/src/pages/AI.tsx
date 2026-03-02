import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Loader2,
  MessageSquare,
  Plus,
  Search,
  Send,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { LazyMarkdown } from "@/components/LazyMarkdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { parseAnalyzeStream } from "@/lib/parse-stream";
import { cn } from "@/lib/utils";

interface ToolCall {
  name: string;
  id: string;
  input: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  cost?: number;
}

interface ChatSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

const WIDGET_TOOL_NAMES = ["add_widget", "list_widgets", "remove_widget"];
const hasWidgetTool = (tc: ToolCall) =>
  WIDGET_TOOL_NAMES.some((name) => tc.name.includes(name));

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function AI() {
  const { chatId } = useParams();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeToolName, setActiveToolName] = useState<string | null>(null);
  const [sidebarSearch, setSidebarSearch] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const [initialQuery, setInitialQuery] = useQueryState("q", parseAsString);
  const autoSentRef = useRef(false);
  const currentChatIdRef = useRef<string | null>(chatId || null);

  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: () => fetch("/api/v2/stats").then((res) => res.json()),
  });

  const { data: chats = [] } = useQuery<ChatSummary[]>({
    queryKey: ["chats"],
    queryFn: () => fetch("/api/v2/chats").then((res) => res.json()),
    refetchInterval: 10000,
  });

  // Load existing chat from URL
  useEffect(() => {
    if (!chatId) {
      setMessages([]);
      currentChatIdRef.current = null;
      autoSentRef.current = false;
      return;
    }
    const controller = new AbortController();
    currentChatIdRef.current = chatId;
    fetch(`/api/v2/chats/${chatId}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) {
          navigate("/ai", { replace: true });
          return;
        }
        const loaded: Message[] = (data.messages || []).map((m: any) => ({
          id: crypto.randomUUID(),
          role: m.role,
          content: m.content,
          toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
          cost: m.cost,
        }));
        setMessages(loaded);
      })
      .catch((e) => {
        if (e.name !== "AbortError") console.error(e);
      });
    return () => controller.abort();
  }, [chatId, navigate]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  const persistMessage = useCallback(
    async (
      cId: string,
      msg: {
        role: string;
        content: string;
        tool_calls?: string;
        cost?: number;
      },
    ) => {
      await fetch(`/api/v2/chats/${cId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(msg),
      });
    },
    [],
  );

  const sendMessage = useCallback(
    async (messageText?: string) => {
      const text = messageText || input.trim();
      if (!text || isStreaming) return;

      setInput("");
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "user", content: text },
      ]);
      setIsStreaming(true);
      setActiveToolName(null);

      // Ensure a chat exists
      let cId = currentChatIdRef.current;
      if (!cId) {
        const res = await fetch("/api/v2/chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: text.substring(0, 50) }),
        });
        const chat = await res.json();
        cId = chat.id;
        currentChatIdRef.current = cId;
        navigate(`/ai/${cId}`, { replace: true });
        queryClient.invalidateQueries({ queryKey: ["chats"] });
      }

      // Persist user message
      await persistMessage(cId!, { role: "user", content: text });

      // Build prompt with conversation history
      let prompt = `You are an AI assistant for Panopticon, an observability tool for Claude Code and Gemini CLI sessions. `;
      prompt += `The database currently has: ${stats?.otel_logs || 0} OTel logs, ${stats?.otel_metrics || 0} metrics, ${stats?.hook_events || 0} hook events. `;

      // Include previous messages for context (exclude the just-added user message)
      const prevMessages = messages.filter((m) => m.content);
      if (prevMessages.length > 0) {
        prompt += `\n\nConversation so far:\n`;
        for (const m of prevMessages) {
          prompt += `${m.role === "user" ? "User" : "Assistant"}: ${m.content}\n\n`;
        }
      }

      prompt += `\nUser: ${text}`;

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          toolCalls: [],
        },
      ]);

      let assistantContent = "";
      const assistantToolCalls: ToolCall[] = [];
      let assistantCost: number | undefined;

      try {
        const response = await fetch("/api/v2/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || "Analysis failed");
        }

        for await (const event of parseAnalyzeStream(response)) {
          switch (event.type) {
            case "text":
              assistantContent += event.content;
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last.role === "assistant") last.content += event.content;
                return updated;
              });
              break;

            case "tool_use_start":
              setActiveToolName(event.name);
              {
                const inputStr = event.input ? JSON.stringify(event.input) : "";
                assistantToolCalls.push({
                  name: event.name,
                  id: event.id,
                  input: inputStr,
                });
              }
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last.role === "assistant") {
                  const inputStr = event.input
                    ? JSON.stringify(event.input)
                    : "";
                  last.toolCalls = [
                    ...(last.toolCalls || []),
                    { name: event.name, id: event.id, input: inputStr },
                  ];
                }
                return updated;
              });
              break;

            case "tool_result":
              setActiveToolName(null);
              break;

            case "result":
              assistantCost = event.cost;
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last.role === "assistant") {
                  last.cost = event.cost;
                  if (!last.content && event.result) {
                    last.content = event.result;
                    assistantContent = event.result;
                  }
                }
                return updated;
              });
              queryClient.invalidateQueries({ queryKey: ["widgets"] });
              break;

            case "error":
              assistantContent += `\n\n**Error:** ${event.error}`;
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last.role === "assistant")
                  last.content += `\n\n**Error:** ${event.error}`;
                return updated;
              });
              break;
          }
        }
      } catch (e: any) {
        assistantContent = `**Error:** ${e.message}`;
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last.role === "assistant")
            last.content = `**Error:** ${e.message}`;
          return updated;
        });
      } finally {
        setIsStreaming(false);
        setActiveToolName(null);
        queryClient.invalidateQueries({ queryKey: ["widgets"] });

        // Persist assistant message
        if (cId) {
          await persistMessage(cId, {
            role: "assistant",
            content: assistantContent,
            tool_calls:
              assistantToolCalls.length > 0
                ? JSON.stringify(assistantToolCalls)
                : undefined,
            cost: assistantCost,
          });
          queryClient.invalidateQueries({ queryKey: ["chats"] });
        }
      }
    },
    [
      input,
      isStreaming,
      stats,
      queryClient,
      navigate,
      persistMessage,
      messages,
    ],
  );

  // Auto-send initial query from ?q= URL param
  useEffect(() => {
    if (initialQuery && !autoSentRef.current && !isStreaming) {
      autoSentRef.current = true;
      setInitialQuery(null);
      sendMessage(initialQuery);
    }
  }, [initialQuery, isStreaming, sendMessage, setInitialQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleNewChat = useCallback(() => {
    currentChatIdRef.current = null;
    setMessages([]);
    navigate("/ai");
  }, [navigate]);

  const handleDeleteChat = useCallback(
    async (e: React.MouseEvent, id: string) => {
      e.stopPropagation();
      await fetch(`/api/v2/chats/${id}`, { method: "DELETE" });
      queryClient.invalidateQueries({ queryKey: ["chats"] });
      if (currentChatIdRef.current === id) {
        handleNewChat();
      }
    },
    [queryClient, handleNewChat],
  );

  const filteredChats = sidebarSearch
    ? chats.filter((c) =>
        c.title.toLowerCase().includes(sidebarSearch.toLowerCase()),
      )
    : chats;

  return (
    <div className="h-full flex">
      {/* Sidebar */}
      <div className="w-64 border-r border-slate-800 bg-slate-900/50 flex flex-col shrink-0">
        <div className="p-3 border-b border-slate-800">
          <Button
            onClick={handleNewChat}
            variant="outline"
            className="w-full justify-start gap-2 text-xs border-slate-700 bg-slate-950 hover:bg-slate-800"
          >
            <Plus className="w-3.5 h-3.5" />
            New Chat
          </Button>
        </div>
        <div className="p-3 border-b border-slate-800">
          <div className="relative">
            <Input
              value={sidebarSearch}
              onChange={(e) => setSidebarSearch(e.target.value)}
              placeholder="Search chats..."
              className="h-7 pl-7 bg-slate-950 border-slate-800 text-xs"
            />
            <Search className="w-3 h-3 absolute left-2.5 top-2 text-slate-500" />
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-0.5">
            {filteredChats.map((chat) => (
              <div
                key={chat.id}
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/ai/${chat.id}`)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ")
                    navigate(`/ai/${chat.id}`);
                }}
                className={cn(
                  "px-3 py-2 rounded-lg cursor-pointer text-xs transition-all group flex items-center gap-2",
                  chatId === chat.id
                    ? "bg-slate-800 text-white"
                    : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-200",
                )}
              >
                <MessageSquare className="w-3.5 h-3.5 shrink-0 text-slate-500" />
                <div className="flex-1 min-w-0">
                  <div className="truncate">{chat.title}</div>
                  <div className="text-[10px] text-slate-600">
                    {formatRelativeTime(chat.updated_at)}
                  </div>
                </div>
                <button
                  onClick={(e) => handleDeleteChat(e, chat.id)}
                  className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-red-400 transition-opacity"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
            {filteredChats.length === 0 && (
              <div className="text-center text-slate-600 text-xs py-8">
                {sidebarSearch ? "No matches" : "No chats yet"}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="p-6 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center space-x-3">
            <div className="bg-blue-600 text-white p-2 rounded-lg">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-xl font-black text-white tracking-tight">
                AI Assistant
              </h2>
              <p className="text-slate-500 text-xs">
                Ask questions, analyze patterns, and create and manage dashboard
                widgets.
              </p>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1 p-6" ref={scrollRef}>
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-20">
              <Sparkles className="w-12 h-12 text-slate-700 mb-4" />
              <h3 className="text-lg font-bold text-slate-400 mb-2">
                Start a conversation
              </h3>
              <p className="text-slate-600 text-sm max-w-md mb-6">
                Ask about session patterns, debug tool failures, analyze costs,
                or create dashboard widgets.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-w-lg">
                {[
                  "Summarize my most recent session",
                  "Which tools have the highest failure rate?",
                  "Show me cost by day as a chart widget",
                  "Create a KPI widget for total sessions",
                ].map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => setInput(suggestion)}
                    className="text-left text-xs p-3 rounded-lg border border-slate-800 bg-slate-900/50 text-slate-400 hover:bg-slate-800 hover:text-slate-200 hover:border-slate-700 transition-all"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-6 max-w-3xl mx-auto">
              {messages.map((msg, _i) => (
                <div
                  key={msg.id}
                  className={msg.role === "user" ? "flex justify-end" : ""}
                >
                  <div
                    className={
                      msg.role === "user"
                        ? "bg-blue-600/20 border border-blue-800/50 rounded-2xl rounded-br-sm px-4 py-3 max-w-[80%]"
                        : "bg-slate-900/50 border border-slate-800 rounded-2xl rounded-bl-sm px-4 py-3"
                    }
                  >
                    {msg.role === "user" ? (
                      <div className="text-sm text-blue-100">{msg.content}</div>
                    ) : (
                      <>
                        {/* Tool calls */}
                        {msg.toolCalls?.map((tc) => (
                          <div
                            key={tc.id}
                            className="my-2 p-3 rounded-lg border border-slate-700 bg-slate-950/50"
                          >
                            <div className="flex items-center gap-2 text-xs mb-1">
                              <Wrench className="w-3 h-3 text-amber-400" />
                              <span className="font-mono font-bold text-amber-400">
                                {tc.name.replace(/^mcp__panopticon__/, "")}
                              </span>
                              {hasWidgetTool(tc) && (
                                <Link
                                  to="/dashboard"
                                  className="ml-auto flex items-center gap-1 text-blue-400 hover:text-blue-300"
                                >
                                  <ExternalLink className="w-3 h-3" />
                                  <span>Dashboard</span>
                                </Link>
                              )}
                            </div>
                            {tc.input && (
                              <div className="text-[10px] text-slate-500 font-mono truncate mt-1">
                                {tc.input.substring(0, 200)}
                              </div>
                            )}
                          </div>
                        ))}

                        {/* Text content */}
                        {msg.content ? (
                          <LazyMarkdown content={msg.content} />
                        ) : !msg.toolCalls?.length ? (
                          <div className="flex items-center space-x-2 text-slate-500 text-sm">
                            <Loader2 className="w-4 h-4 animate-spin" />
                            <span>Thinking...</span>
                          </div>
                        ) : null}

                        {/* Cost badge */}
                        {msg.cost != null && msg.cost > 0 && (
                          <div className="mt-2 pt-2 border-t border-slate-800/50">
                            <Badge
                              variant="outline"
                              className="text-[9px] text-slate-500 border-slate-700"
                            >
                              Cost: ${msg.cost.toFixed(4)}
                            </Badge>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}

              {/* Active tool indicator */}
              {activeToolName && (
                <div className="flex items-center gap-2 text-xs text-amber-400 animate-pulse">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>
                    Calling {activeToolName.replace(/^mcp__panopticon__/, "")}
                    ...
                  </span>
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        <div className="p-4 border-t border-slate-800 bg-slate-900/50">
          <div className="flex space-x-3 max-w-3xl mx-auto">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Ask about your sessions, costs, tool usage... or create widgets"
              className="flex-1 bg-slate-950 border-slate-800 text-sm resize-none min-h-[40px] max-h-[120px]"
              rows={1}
              disabled={isStreaming}
            />
            <Button
              onClick={() => sendMessage()}
              disabled={!input.trim() || isStreaming}
              className="bg-blue-600 hover:bg-blue-700 px-4 self-end"
              data-send-btn
            >
              {isStreaming ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
