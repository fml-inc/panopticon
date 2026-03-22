/**
 * Accumulate SSE streaming responses into a final reconstructed message.
 * Forwards chunks to the client in real-time while buffering for capture.
 */

export interface StreamAccumulator {
  /** Feed a raw SSE chunk. Returns the chunk unchanged (for forwarding). */
  push(chunk: Buffer): Buffer;
  /** Finalize and return the reconstructed response body. */
  finish(): Record<string, unknown>;
}

/** Create an accumulator for Anthropic streaming format. */
export function createAnthropicAccumulator(): StreamAccumulator {
  let message: Record<string, unknown> = {};
  let usage: Record<string, number> = {};
  const contentBlocks: Array<Record<string, unknown>> = [];
  let currentBlockIndex = -1;
  const textParts = new Map<number, string>();

  return {
    push(chunk: Buffer): Buffer {
      const text = chunk.toString("utf-8");
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data);
          switch (event.type) {
            case "message_start":
              message = event.message ?? {};
              usage = (event.message?.usage as Record<string, number>) ?? {};
              break;
            case "content_block_start":
              currentBlockIndex = event.index ?? contentBlocks.length;
              contentBlocks[currentBlockIndex] = event.content_block ?? {};
              break;
            case "content_block_delta":
              if (event.delta?.type === "text_delta" && event.delta.text) {
                const idx = event.index ?? currentBlockIndex;
                textParts.set(
                  idx,
                  (textParts.get(idx) ?? "") + event.delta.text,
                );
              } else if (
                event.delta?.type === "input_json_delta" &&
                event.delta.partial_json
              ) {
                const idx = event.index ?? currentBlockIndex;
                textParts.set(
                  idx,
                  (textParts.get(idx) ?? "") + event.delta.partial_json,
                );
              }
              break;
            case "message_delta":
              if (event.delta) {
                Object.assign(message, event.delta);
              }
              if (event.usage) {
                Object.assign(usage, event.usage);
              }
              break;
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
      return chunk;
    },

    finish(): Record<string, unknown> {
      // Reconstruct content blocks with accumulated text
      const content = contentBlocks.map((block, i) => {
        if (block.type === "text") {
          return { ...block, text: textParts.get(i) ?? block.text ?? "" };
        }
        if (block.type === "tool_use") {
          const raw = textParts.get(i);
          let input = block.input;
          if (raw) {
            try {
              input = JSON.parse(raw);
            } catch {
              input = { raw };
            }
          }
          return { ...block, input };
        }
        return block;
      });

      return {
        ...message,
        content,
        usage,
      };
    },
  };
}

/** Create an accumulator for OpenAI streaming format. */
export function createOpenaiAccumulator(): StreamAccumulator {
  let model = "";
  let finishReason: string | null = null;
  let role = "";
  let contentParts = "";
  const toolCalls = new Map<
    number,
    { id: string; type: string; function: { name: string; arguments: string } }
  >();
  let usage: Record<string, number> = {};

  return {
    push(chunk: Buffer): Buffer {
      const text = chunk.toString("utf-8");
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const event = JSON.parse(data);
          if (event.model) model = event.model;
          if (event.usage) usage = event.usage;

          const choice = event.choices?.[0];
          if (!choice) continue;

          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta;
          if (!delta) continue;

          if (delta.role) role = delta.role;
          if (delta.content) contentParts += delta.content;

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCalls.get(idx);
              if (existing) {
                if (tc.function?.arguments) {
                  existing.function.arguments += tc.function.arguments;
                }
              } else {
                toolCalls.set(idx, {
                  id: tc.id ?? "",
                  type: tc.type ?? "function",
                  function: {
                    name: tc.function?.name ?? "",
                    arguments: tc.function?.arguments ?? "",
                  },
                });
              }
            }
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
      return chunk;
    },

    finish(): Record<string, unknown> {
      const message: Record<string, unknown> = {
        role: role || "assistant",
        content: contentParts || null,
      };

      if (toolCalls.size > 0) {
        message.tool_calls = [...toolCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => tc);
      }

      return {
        model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: finishReason,
          },
        ],
        usage,
      };
    },
  };
}

/** Detect if a request is asking for streaming. */
export function isStreamingRequest(body: unknown): boolean {
  if (typeof body === "object" && body !== null) {
    return (body as Record<string, unknown>).stream === true;
  }
  return false;
}
