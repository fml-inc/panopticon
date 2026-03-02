import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Brain,
  FileJson,
  Sparkles,
  User,
  Wrench,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { LazyMarkdown, LazySyntaxHighlighter } from "@/components/LazyMarkdown";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { parseAnalyzeStream } from "@/lib/parse-stream";

export function EventDetailsPanel() {
  const { sessionId, source, eventId } = useParams();
  const navigate = useNavigate();
  const activeEventId = source && eventId ? `${source}:${eventId}` : null;

  const [analysisText, setAnalysisText] = useState("");
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [showAnalysisInput, setShowAnalysisInput] = useState(false);
  const [promptInput, setPromptInput] = useState("");

  const { data: event, isLoading } = useQuery({
    queryKey: ["event", activeEventId],
    queryFn: () =>
      fetch(`/api/v2/events/${source}/${eventId}`).then((res) => res.json()),
    enabled: !!activeEventId,
  });

  const closePanel = () => {
    if (sessionId) {
      navigate(`/sessions/${sessionId}`);
    }
  };

  const generateAnalysisPrompt = (event: any) => {
    let prompt = `Analyze the following event from Panopticon:\n\n`;
    prompt += `Event Type: ${event.event_type}\n`;
    prompt += `Timestamp: ${new Date(event.timestamp_ms).toLocaleString()}\n`;
    if (event.tool_name) prompt += `Tool Name: ${event.tool_name}\n`;
    if (event.session_id) prompt += `Session ID: ${event.session_id}\n`;
    if (event.body) prompt += `Message Body: ${event.body}\n`;
    if (event.payload) {
      prompt += `\nPayload:\n\`\`\`json\n${JSON.stringify(event.payload, null, 2)}\n\`\`\`\n\n`;
    }
    prompt += `What insights can you provide? Suggest next steps or potential fixes if applicable.`;
    return prompt;
  };

  const abortControllerRef = useRef<AbortController | null>(null);

  const startAnalysis = async () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setAnalysisText("");
    setAnalysisError(null);
    setAnalysisLoading(true);

    try {
      const response = await fetch("/api/v2/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: promptInput || generateAnalysisPrompt(event),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to start analysis");
      }

      for await (const evt of parseAnalyzeStream(response)) {
        if (controller.signal.aborted) break;
        if (evt.type === "text") {
          setAnalysisText((prev) => prev + evt.content);
        } else if (evt.type === "error") {
          setAnalysisError(evt.error);
          setAnalysisText((prev) => `${prev}\n\n**AI Error:** ${evt.error}\n`);
        }
      }
    } catch (e: any) {
      if (e.name !== "AbortError") {
        setAnalysisError(
          e.message || "An unknown error occurred during analysis.",
        );
      }
    } finally {
      setAnalysisLoading(false);
      setShowAnalysisInput(false);
    }
  };

  return (
    <div className="h-full flex flex-col bg-slate-900 border-l border-slate-800 relative">
      <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-900 shrink-0 sticky top-0 z-10">
        <div className="min-w-0 pr-4">
          <div className="flex items-center space-x-2 mb-1">
            {event?.source === "hook" ? (
              <Badge
                variant="outline"
                className="bg-blue-950/30 text-blue-400 border-blue-900"
              >
                Hook
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="bg-amber-950/30 text-amber-400 border-amber-900"
              >
                OTel
              </Badge>
            )}
            <h3 className="font-black text-white uppercase tracking-tight truncate">
              {event?.event_type}
            </h3>
          </div>
          <div className="text-[10px] text-slate-500 font-mono">
            {event ? new Date(event.timestamp_ms).toLocaleString() : "..."}
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowAnalysisInput((prev) => !prev);
              if (!showAnalysisInput && event) {
                setPromptInput(generateAnalysisPrompt(event));
              } else {
                setPromptInput("");
              }
              setAnalysisText("");
              setAnalysisError(null);
            }}
            className="text-xs h-7 px-3 bg-slate-800 hover:bg-slate-700 text-blue-400 hover:text-blue-200"
            disabled={isLoading || analysisLoading}
          >
            {analysisLoading ? (
              "Analyzing..."
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5 mr-2" /> Analyze
              </>
            )}
          </Button>
          <Button
            onClick={closePanel}
            className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-white transition-colors shrink-0"
            variant="ghost"
            size="sm"
          >
            <X className="w-5 h-5" />
          </Button>
        </div>
      </div>

      {showAnalysisInput && event && (
        <div className="p-4 border-b border-slate-800 bg-slate-950/50">
          <Textarea
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            placeholder="Enter your prompt for Claude..."
            className="h-24 bg-slate-900 border-slate-700 text-xs text-slate-200 resize-y mb-2"
          />
          <Button
            onClick={startAnalysis}
            className="w-full text-xs h-7 bg-blue-600 hover:bg-blue-700"
            disabled={analysisLoading || !promptInput}
          >
            {analysisLoading ? "Generating Analysis..." : "Run Analysis"}
          </Button>
        </div>
      )}

      <ScrollArea className="flex-1">
        {isLoading ? (
          <div className="p-8 text-slate-500 font-mono text-sm animate-pulse">
            Loading event payload...
          </div>
        ) : (
          <div className="pb-8">
            {event?.tool_name && (
              <div className="p-4 bg-slate-950/50 border-b border-slate-800 flex items-center space-x-3">
                <div className="w-8 h-8 rounded-lg bg-blue-900/20 border border-blue-800/50 flex items-center justify-center text-blue-400">
                  <Wrench className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-[9px] uppercase font-black text-slate-500 tracking-widest">
                    Tool Execution
                  </div>
                  <div className="text-sm font-mono text-blue-300 font-bold">
                    {String(event.tool_name)}
                  </div>
                </div>
              </div>
            )}

            {event?.body && (
              <div className="p-4 bg-slate-950/50 border-b border-slate-800 flex items-start space-x-3">
                <div className="w-8 h-8 rounded-lg bg-amber-900/20 border border-amber-800/50 flex items-center justify-center text-amber-400 shrink-0">
                  <AlertCircle className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-[9px] uppercase font-black text-slate-500 tracking-widest mb-1">
                    Message Body
                  </div>
                  <div className="text-xs font-mono text-slate-300 whitespace-pre-wrap leading-relaxed">
                    {String(event.body)}
                  </div>
                </div>
              </div>
            )}

            {analysisText && (
              <Accordion
                type="single"
                collapsible
                defaultValue="analysis-output"
              >
                <AccordionItem value="analysis-output" className="border-none">
                  <AccordionTrigger className="p-4 text-xs font-bold uppercase tracking-widest text-blue-400 hover:no-underline border-b border-slate-800 bg-slate-950/50 hover:bg-slate-900/50">
                    AI Analysis
                  </AccordionTrigger>
                  <AccordionContent className="p-0 bg-slate-950">
                    <LazyMarkdown content={analysisText} />
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            )}

            {analysisError && (
              <div className="p-4 text-red-400 bg-red-950/20 border-b border-red-900/30 text-xs font-mono">
                Error: {analysisError}
              </div>
            )}

            <div className="p-4">
              <Tabs
                defaultValue={
                  event?.payload?.user_prompt
                    ? "prompt"
                    : event?.payload?.thoughts
                      ? "thoughts"
                      : event?.payload?.tool_input
                        ? "input"
                        : "raw"
                }
                className="w-full"
              >
                <TabsList className="w-full justify-start bg-slate-950 border border-slate-800 rounded-lg p-1 h-auto flex-wrap">
                  {event?.payload?.user_prompt && (
                    <TabsTrigger
                      value="prompt"
                      className="text-xs data-[state=active]:bg-slate-800"
                    >
                      <User className="w-3.5 h-3.5 mr-2" /> User Prompt
                    </TabsTrigger>
                  )}
                  {event?.payload?.thoughts && (
                    <TabsTrigger
                      value="thoughts"
                      className="text-xs data-[state=active]:bg-slate-800"
                    >
                      <Brain className="w-3.5 h-3.5 mr-2" /> Thoughts
                    </TabsTrigger>
                  )}
                  {event?.payload?.tool_input && (
                    <TabsTrigger
                      value="input"
                      className="text-xs data-[state=active]:bg-slate-800"
                    >
                      <Wrench className="w-3.5 h-3.5 mr-2" /> Tool Input
                    </TabsTrigger>
                  )}
                  {event?.payload?.tool_result && (
                    <TabsTrigger
                      value="result"
                      className="text-xs data-[state=active]:bg-slate-800"
                    >
                      <FileJson className="w-3.5 h-3.5 mr-2" /> Tool Result
                    </TabsTrigger>
                  )}
                  <TabsTrigger
                    value="raw"
                    className="text-xs data-[state=active]:bg-slate-800"
                  >
                    <FileJson className="w-3.5 h-3.5 mr-2" /> Raw JSON
                  </TabsTrigger>
                </TabsList>

                <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950 overflow-hidden">
                  {event?.payload?.user_prompt && (
                    <TabsContent value="prompt" className="m-0">
                      <LazyMarkdown content={event.payload.user_prompt} />
                    </TabsContent>
                  )}
                  {event?.payload?.thoughts && (
                    <TabsContent value="thoughts" className="m-0">
                      <LazyMarkdown content={event.payload.thoughts} />
                    </TabsContent>
                  )}
                  {event?.payload?.tool_input && (
                    <TabsContent value="input" className="m-0">
                      <LazySyntaxHighlighter
                        code={
                          typeof event.payload.tool_input === "string"
                            ? event.payload.tool_input
                            : JSON.stringify(event.payload.tool_input, null, 2)
                        }
                        language="json"
                      />
                    </TabsContent>
                  )}
                  {event?.payload?.tool_result && (
                    <TabsContent value="result" className="m-0">
                      <LazySyntaxHighlighter
                        code={
                          typeof event.payload.tool_result === "string"
                            ? event.payload.tool_result
                            : JSON.stringify(event.payload.tool_result, null, 2)
                        }
                        language="json"
                      />
                    </TabsContent>
                  )}
                  <TabsContent value="raw" className="m-0">
                    <LazySyntaxHighlighter
                      code={JSON.stringify(event?.payload, null, 2)}
                      language="json"
                    />
                  </TabsContent>
                </div>
              </Tabs>
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
