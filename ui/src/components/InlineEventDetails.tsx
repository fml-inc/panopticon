import { useQuery } from "@tanstack/react-query";
import { Brain, FileJson, User, Wrench } from "lucide-react";
import { LazyMarkdown, LazySyntaxHighlighter } from "@/components/LazyMarkdown";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface InlineEventDetailsProps {
  source: string;
  eventId: number;
}

export function InlineEventDetails({
  source,
  eventId,
}: InlineEventDetailsProps) {
  const { data: event, isLoading } = useQuery({
    queryKey: ["event", `${source}:${eventId}`],
    queryFn: () =>
      fetch(`/api/v2/events/${source}/${eventId}`).then((res) => res.json()),
  });

  if (isLoading) {
    return (
      <div className="p-3 text-slate-500 font-mono text-[10px] animate-pulse">
        Loading payload...
      </div>
    );
  }

  if (!event) return null;

  const hasPrompt = !!event.payload?.user_prompt;
  const hasThoughts = !!event.payload?.thoughts;
  const hasInput = !!event.payload?.tool_input;
  const hasResult = !!event.payload?.tool_result;
  const defaultTab = hasPrompt
    ? "prompt"
    : hasThoughts
      ? "thoughts"
      : hasInput
        ? "input"
        : "raw";

  return (
    <div className="mt-2 rounded-lg border border-slate-800/50 bg-slate-950/80 overflow-hidden">
      {event.tool_name && (
        <div className="px-3 py-2 border-b border-slate-800/50 flex items-center gap-2">
          <Wrench className="w-3 h-3 text-blue-400" />
          <span className="text-[10px] font-mono text-blue-300 font-bold">
            {event.tool_name}
          </span>
        </div>
      )}

      {event.body && (
        <div className="px-3 py-2 border-b border-slate-800/50 text-[10px] font-mono text-slate-400 whitespace-pre-wrap max-h-20 overflow-auto">
          {event.body}
        </div>
      )}

      <Tabs defaultValue={defaultTab} className="w-full">
        <TabsList className="w-full justify-start bg-transparent border-b border-slate-800/50 rounded-none p-0 h-auto">
          {hasPrompt && (
            <TabsTrigger
              value="prompt"
              className="text-[10px] rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent px-3 py-1.5"
            >
              <User className="w-3 h-3 mr-1" />
              Prompt
            </TabsTrigger>
          )}
          {hasThoughts && (
            <TabsTrigger
              value="thoughts"
              className="text-[10px] rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent px-3 py-1.5"
            >
              <Brain className="w-3 h-3 mr-1" />
              Thoughts
            </TabsTrigger>
          )}
          {hasInput && (
            <TabsTrigger
              value="input"
              className="text-[10px] rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent px-3 py-1.5"
            >
              <Wrench className="w-3 h-3 mr-1" />
              Input
            </TabsTrigger>
          )}
          {hasResult && (
            <TabsTrigger
              value="result"
              className="text-[10px] rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent px-3 py-1.5"
            >
              <FileJson className="w-3 h-3 mr-1" />
              Result
            </TabsTrigger>
          )}
          <TabsTrigger
            value="raw"
            className="text-[10px] rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent px-3 py-1.5"
          >
            <FileJson className="w-3 h-3 mr-1" />
            Raw
          </TabsTrigger>
        </TabsList>

        <div className="max-h-48 overflow-auto">
          {hasPrompt && (
            <TabsContent value="prompt" className="m-0">
              <LazyMarkdown
                content={event.payload.user_prompt}
                className="prose prose-invert prose-xs max-w-none p-3 text-[11px]"
              />
            </TabsContent>
          )}
          {hasThoughts && (
            <TabsContent value="thoughts" className="m-0">
              <LazyMarkdown
                content={event.payload.thoughts}
                className="prose prose-invert prose-xs max-w-none p-3 text-[11px]"
              />
            </TabsContent>
          )}
          {hasInput && (
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
          {hasResult && (
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
  );
}
