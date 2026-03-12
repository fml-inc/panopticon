export type StreamEvent =
  | { type: "text"; content: string }
  | { type: "tool_use_start"; name: string; id: string; input?: any }
  | { type: "tool_result"; tool_use_id: string; content: any }
  | { type: "result"; cost?: number; duration?: number; result?: string }
  | { type: "error"; error: string }
  | { type: "done" };

/**
 * Parse SSE events from /api/v2/analyze endpoint.
 * Yields typed StreamEvent objects as they arrive.
 */
export async function* parseAnalyzeStream(
  response: Response,
): AsyncGenerator<StreamEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response stream");

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let eventEndIndex: number = buffer.indexOf("\n\n");
      while (eventEndIndex !== -1) {
        const eventString = buffer.substring(0, eventEndIndex);
        buffer = buffer.substring(eventEndIndex + 2);

        const eventTypeMatch = eventString.match(/^event: (.*)\n/);
        const dataMatch = eventString.match(/\ndata: (.*)$/);

        if (eventTypeMatch && dataMatch) {
          try {
            const data = JSON.parse(dataMatch[1]);
            const eventType = eventTypeMatch[1];

            switch (eventType) {
              case "text":
                yield { type: "text", content: data.content || "" };
                break;
              case "tool_use_start":
                yield {
                  type: "tool_use_start",
                  name: data.name,
                  id: data.id,
                  input: data.input,
                };
                break;
              case "tool_result":
                yield {
                  type: "tool_result",
                  tool_use_id: data.tool_use_id,
                  content: data.content,
                };
                break;
              case "result":
                yield {
                  type: "result",
                  cost: data.cost,
                  duration: data.duration,
                  result: data.result,
                };
                break;
              case "error":
                yield { type: "error", error: data.error || "Unknown error" };
                break;
              case "done":
                yield { type: "done" };
                break;
            }
          } catch {
            // Skip unparseable events
          }
        }
        eventEndIndex = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}
