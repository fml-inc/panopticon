import type { HookInput, OtelMetricPayload } from "../emit.js";
import type { ApiFormatParser, CapturedExchange } from "./types.js";

/** Parse OpenAI Chat Completions API (/v1/chat/completions) request/response. */
export const openaiParser: ApiFormatParser = {
  matches(path: string): boolean {
    return path.includes("/v1/chat/completions");
  },

  extractEvents(capture: CapturedExchange): HookInput[] {
    const events: HookInput[] = [];
    const { request, response, sessionId } = capture;
    const reqBody = request.body as Record<string, unknown> | undefined;
    const resBody = response.body as Record<string, unknown> | undefined;

    if (!reqBody) return events;

    // Extract user prompt from the last user message
    const messages = reqBody.messages as
      | Array<{ role: string; content: unknown; tool_call_id?: string }>
      | undefined;
    if (messages) {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      if (lastUser) {
        const prompt = extractTextContent(lastUser.content);
        if (prompt) {
          events.push({
            session_id: sessionId,
            hook_event_name: "UserPromptSubmit",
            prompt,
          });
        }
      }

      // Extract tool results from request (PostToolUse for prior tool calls)
      for (const msg of messages) {
        if (msg.role === "tool") {
          events.push({
            session_id: sessionId,
            hook_event_name: "PostToolUse",
            tool_name: (msg.tool_call_id as string) ?? "unknown",
            tool_input: {
              tool_call_id: msg.tool_call_id,
              content: extractTextContent(msg.content),
            },
          });
        }
      }
    }

    // Extract tool_calls from response (PreToolUse)
    if (resBody) {
      const choices = resBody.choices as
        | Array<{ message?: { tool_calls?: Array<Record<string, unknown>> } }>
        | undefined;
      if (choices) {
        for (const choice of choices) {
          const toolCalls = choice.message?.tool_calls;
          if (toolCalls) {
            for (const tc of toolCalls) {
              const fn = tc.function as
                | { name?: string; arguments?: string }
                | undefined;
              let parsedArgs: Record<string, unknown> = {};
              if (fn?.arguments) {
                try {
                  parsedArgs = JSON.parse(fn.arguments);
                } catch {
                  parsedArgs = { raw: fn.arguments };
                }
              }
              events.push({
                session_id: sessionId,
                hook_event_name: "PreToolUse",
                tool_name: fn?.name ?? "unknown",
                tool_input: parsedArgs,
              });
            }
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
      if (usage.prompt_tokens) {
        metrics.push({
          name: "token.usage",
          value: usage.prompt_tokens,
          attributes: {
            model,
            token_type: "input",
            vendor: capture.vendor,
          },
          sessionId: capture.sessionId,
        });
      }
      if (usage.completion_tokens) {
        metrics.push({
          name: "token.usage",
          value: usage.completion_tokens,
          attributes: {
            model,
            token_type: "output",
            vendor: capture.vendor,
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
    const choices = resBody?.choices as
      | Array<{ finish_reason?: string }>
      | undefined;

    return [
      {
        body: "api_request",
        sessionId: capture.sessionId,
        attributes: {
          model,
          vendor: capture.vendor,
          duration_ms: capture.duration_ms,
          status: capture.response.status,
          stop_reason: choices?.[0]?.finish_reason,
          input_tokens: usage?.prompt_tokens,
          output_tokens: usage?.completion_tokens,
        },
      },
    ];
  },
};

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (
      content
        .filter((c: Record<string, unknown>) => c.type === "text")
        .map((c: Record<string, unknown>) => c.text)
        .join("\n") || undefined
    );
  }
  return undefined;
}
