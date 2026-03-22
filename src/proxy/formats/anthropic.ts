import type { HookInput, OtelMetricPayload } from "../emit.js";
import type { ApiFormatParser, CapturedExchange } from "./types.js";

/** Parse Anthropic Messages API (/v1/messages) request/response. */
export const anthropicParser: ApiFormatParser = {
  matches(path: string): boolean {
    return path.includes("/v1/messages");
  },

  extractEvents(capture: CapturedExchange): HookInput[] {
    const events: HookInput[] = [];
    const { request, response, sessionId } = capture;
    const reqBody = request.body as Record<string, unknown> | undefined;
    const resBody = response.body as Record<string, unknown> | undefined;

    if (!reqBody) return events;

    // Extract user prompt from the last user message in the request
    const messages = reqBody.messages as
      | Array<{ role: string; content: unknown }>
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
        if (msg.role === "tool" || msg.role === "tool_result") {
          const toolMsg = msg as Record<string, unknown>;
          events.push({
            session_id: sessionId,
            hook_event_name: "PostToolUse",
            tool_name: (toolMsg.tool_use_id as string) ?? "unknown",
            tool_input: {
              tool_use_id: toolMsg.tool_use_id,
              content: extractTextContent(toolMsg.content),
            },
          });
        }
      }
    }

    // Extract tool_use blocks from response (PreToolUse)
    if (resBody && Array.isArray(resBody.content)) {
      for (const block of resBody.content) {
        if (block.type === "tool_use") {
          events.push({
            session_id: sessionId,
            hook_event_name: "PreToolUse",
            tool_name: block.name ?? "unknown",
            tool_input: block.input ?? {},
          });
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
    if (!resBody) return metrics;

    const usage = resBody.usage as Record<string, number> | undefined;
    const model = (resBody.model as string) ?? "unknown";

    if (usage) {
      if (usage.input_tokens) {
        metrics.push({
          name: "token.usage",
          value: usage.input_tokens,
          attributes: {
            model,
            token_type: "input",
            vendor: capture.vendor,
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
            vendor: capture.vendor,
          },
          sessionId: capture.sessionId,
        });
      }
      if (usage.cache_read_input_tokens) {
        metrics.push({
          name: "token.usage",
          value: usage.cache_read_input_tokens,
          attributes: {
            model,
            token_type: "cacheRead",
            vendor: capture.vendor,
          },
          sessionId: capture.sessionId,
        });
      }
      if (usage.cache_creation_input_tokens) {
        metrics.push({
          name: "token.usage",
          value: usage.cache_creation_input_tokens,
          attributes: {
            model,
            token_type: "cacheWrite",
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

    return [
      {
        body: "api_request",
        sessionId: capture.sessionId,
        attributes: {
          model,
          vendor: capture.vendor,
          duration_ms: capture.duration_ms,
          status: capture.response.status,
          stop_reason: resBody?.stop_reason,
          input_tokens: usage?.input_tokens,
          output_tokens: usage?.output_tokens,
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
