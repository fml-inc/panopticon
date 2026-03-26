import type { HookInput, OtelMetricPayload } from "../emit.js";
import type { ApiFormatParser, CapturedExchange } from "./types.js";

/** Parse OpenAI Responses API (/v1/responses, /backend-api/codex/responses). */
export const openaiResponsesParser: ApiFormatParser = {
  matches(path: string): boolean {
    return path.endsWith("/responses") || path.includes("/responses?");
  },

  extractEvents(capture: CapturedExchange): HookInput[] {
    const events: HookInput[] = [];
    const { request, response, sessionId } = capture;
    const reqBody = request.body as Record<string, unknown> | undefined;
    const resBody = response.body as Record<string, unknown> | undefined;

    if (!reqBody) return events;

    // Extract user prompt from input field
    const input = reqBody.input;
    const prompt = extractInputText(input);
    if (prompt) {
      events.push({
        session_id: sessionId,
        hook_event_name: "UserPromptSubmit",
        prompt,
      });
    }

    // Extract tool results from input (function_call_output items)
    if (Array.isArray(input)) {
      for (const item of input) {
        const it = item as Record<string, unknown>;
        if (it.type === "function_call_output") {
          events.push({
            session_id: sessionId,
            hook_event_name: "PostToolUse",
            tool_name: (it.call_id as string) ?? "unknown",
            tool_input: {
              call_id: it.call_id,
              content: it.output,
            },
          });
        }
      }
    }

    // Extract tool calls from response output (function_call items)
    if (resBody) {
      const output = resBody.output as
        | Array<Record<string, unknown>>
        | undefined;
      if (output) {
        for (const item of output) {
          if (item.type === "function_call") {
            let parsedArgs: Record<string, unknown> = {};
            if (typeof item.arguments === "string") {
              try {
                parsedArgs = JSON.parse(item.arguments);
              } catch {
                parsedArgs = { raw: item.arguments };
              }
            }
            events.push({
              session_id: sessionId,
              hook_event_name: "PreToolUse",
              tool_name: (item.name as string) ?? "unknown",
              tool_input: parsedArgs,
            });
          }
        }
      }
    }

    return events;
  },

  extractMetrics(capture: CapturedExchange): OtelMetricPayload[] {
    const metrics: OtelMetricPayload[] = [];
    const resBody = capture.response.body as
      | Record<string, unknown>
      | undefined;
    const reqBody = capture.request.body as Record<string, unknown> | undefined;
    if (!resBody) return metrics;

    const usage = resBody.usage as Record<string, number> | undefined;
    const model =
      (resBody.model as string) ?? (reqBody?.model as string) ?? "unknown";

    if (usage) {
      if (usage.input_tokens) {
        metrics.push({
          name: "token.usage",
          value: usage.input_tokens,
          attributes: {
            model,
            token_type: "input",
            target: capture.target,
          },
          sessionId: capture.sessionId,
        });
      }
      if (usage.output_tokens) {
        metrics.push({
          name: "token.usage",
          value: usage.output_tokens,
          attributes: {
            model,
            token_type: "output",
            target: capture.target,
          },
          sessionId: capture.sessionId,
        });
      }
    }

    return metrics;
  },

  extractLogs(capture: CapturedExchange) {
    const resBody = capture.response.body as
      | Record<string, unknown>
      | undefined;
    const reqBody = capture.request.body as Record<string, unknown> | undefined;
    const model =
      (resBody?.model as string) ?? (reqBody?.model as string) ?? "unknown";
    const usage = resBody?.usage as Record<string, number> | undefined;

    return [
      {
        body: "api_request",
        sessionId: capture.sessionId,
        attributes: {
          model,
          target: capture.target,
          duration_ms: capture.duration_ms,
          status: capture.response.status,
          stop_reason: resBody?.status,
          input_tokens: usage?.input_tokens,
          output_tokens: usage?.output_tokens,
        },
      },
    ];
  },
};

/** Extract text from the Responses API input field. */
function extractInputText(input: unknown): string | undefined {
  // String input: "hello"
  if (typeof input === "string") return input;

  if (!Array.isArray(input)) return undefined;

  // Array of messages or items — find the last user content
  const texts: string[] = [];
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i] as Record<string, unknown>;

    // Message format: { role: "user", content: "hello" }
    if (item.role === "user") {
      const text = extractContentField(item.content);
      if (text) return text;
    }

    // Item format: { type: "message", role: "user", content: [...] }
    if (item.type === "message" && item.role === "user") {
      const text = extractContentField(item.content);
      if (text) return text;
    }

    // Inline text item: { type: "input_text", text: "hello" }
    if (item.type === "input_text" && typeof item.text === "string") {
      texts.unshift(item.text);
    }
  }

  return texts.length > 0 ? texts.join("\n") : undefined;
}

function extractContentField(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (
      content
        .filter(
          (c: Record<string, unknown>) =>
            c.type === "input_text" || c.type === "text",
        )
        .map((c: Record<string, unknown>) => c.text)
        .join("\n") || undefined
    );
  }
  return undefined;
}
