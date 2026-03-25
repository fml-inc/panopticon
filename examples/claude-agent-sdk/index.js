/**
 * Panopticon SDK demo — observe a Claude Agent SDK session.
 *
 * Prerequisites:
 *   1. panopticon server running: panopticon start
 *   2. Claude Code logged in (`claude auth status`) — uses Claude Code's
 *      own OAuth session, no ANTHROPIC_API_KEY needed
 *
 * Usage:
 *   cd examples/sdk-demo
 *   npm install
 *   node index.js "your prompt here"
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { observe } from "../../dist/sdk.js";

const prompt = process.argv[2] ?? "What files are in the current directory?";

console.log(`Prompt: ${prompt}`);
console.log("---");

for await (const msg of observe(query({ prompt, options: { maxTurns: 3 } }))) {
  if (msg.type === "assistant") {
    // Print text content from assistant
    for (const block of msg.message?.content ?? []) {
      if (block.type === "text") {
        process.stdout.write(block.text);
      } else if (block.type === "tool_use") {
        console.log(`\n[tool: ${block.name}]`);
      }
    }
  } else if (msg.type === "result") {
    console.log("\n---");
    console.log(`Turns: ${msg.num_turns}`);
    console.log(`Cost: $${msg.total_cost_usd?.toFixed(4)}`);
    console.log(
      `Duration: ${msg.duration_ms}ms (API: ${msg.duration_api_ms}ms)`,
    );
    if (msg.usage) {
      console.log(
        `Tokens: ${msg.usage.input_tokens} in / ${msg.usage.output_tokens} out`,
      );
    }
  }
}
