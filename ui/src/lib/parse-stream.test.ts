import { describe, expect, it } from "vitest";
import { parseAnalyzeStream } from "./parse-stream";

function makeSSEResponse(events: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(events));
      controller.close();
    },
  });
  return new Response(stream);
}

describe("parseAnalyzeStream", () => {
  it("parses text events", async () => {
    const response = makeSSEResponse(
      'event: text\ndata: {"content":"Hello"}\n\n' +
        'event: text\ndata: {"content":" world"}\n\n',
    );

    const events = [];
    for await (const event of parseAnalyzeStream(response)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text", content: "Hello" },
      { type: "text", content: " world" },
    ]);
  });

  it("parses tool use events", async () => {
    const toolStart = JSON.stringify({
      name: "panopticon_query",
      id: "tool_1",
      input: { sql: "SELECT 1" },
    });
    const toolResult = JSON.stringify({ tool_use_id: "tool_1", content: "ok" });
    const response = makeSSEResponse(
      `event: tool_use_start\ndata: ${toolStart}\n\n` +
        `event: tool_result\ndata: ${toolResult}\n\n`,
    );

    const events = [];
    for await (const event of parseAnalyzeStream(response)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "tool_use_start",
      name: "panopticon_query",
      id: "tool_1",
      input: { sql: "SELECT 1" },
    });
    expect(events[1]).toEqual({
      type: "tool_result",
      tool_use_id: "tool_1",
      content: "ok",
    });
  });

  it("parses result events", async () => {
    const response = makeSSEResponse(
      'event: result\ndata: {"cost":0.05,"duration":1200,"result":"Hello!"}\n\n',
    );

    const events = [];
    for await (const event of parseAnalyzeStream(response)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "result", cost: 0.05, duration: 1200, result: "Hello!" },
    ]);
  });

  it("parses done events", async () => {
    const response = makeSSEResponse("event: done\ndata: {}\n\n");

    const events = [];
    for await (const event of parseAnalyzeStream(response)) {
      events.push(event);
    }

    expect(events).toEqual([{ type: "done" }]);
  });

  it("handles mixed events", async () => {
    const toolResultData = JSON.stringify({
      tool_use_id: "t1",
      content: "done",
    });
    const response = makeSSEResponse(
      'event: text\ndata: {"content":"Analyzing..."}\n\n' +
        'event: tool_use_start\ndata: {"name":"query","id":"t1"}\n\n' +
        `event: tool_result\ndata: ${toolResultData}\n\n` +
        'event: text\ndata: {"content":"Done!"}\n\n' +
        'event: result\ndata: {"cost":0.01}\n\n' +
        "event: done\ndata: {}\n\n",
    );

    const events = [];
    for await (const event of parseAnalyzeStream(response)) {
      events.push(event);
    }

    expect(events).toHaveLength(6);
    expect(events[0].type).toBe("text");
    expect(events[1].type).toBe("tool_use_start");
    expect(events[2].type).toBe("tool_result");
    expect(events[4].type).toBe("result");
    expect(events[5].type).toBe("done");
  });

  it("handles empty response body", async () => {
    const response = makeSSEResponse("");

    const events = [];
    for await (const event of parseAnalyzeStream(response)) {
      events.push(event);
    }

    expect(events).toHaveLength(0);
  });
});
