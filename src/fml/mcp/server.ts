#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getValidToken, readTokens } from "../auth/token-store.js";
import { parsePanopticonRunning } from "../commands/daemon.js";
import { authStorePath } from "../config.js";
import { FML_DATA_DIR, FML_LOG_DIR } from "../dirs.js";
import { initSentry, Sentry } from "../sentry.js";
import { registerTools } from "./tools.js";

const LOG_PATH = path.join(FML_LOG_DIR, "mcp.log");

const server = new McpServer({
  name: "fml",
  version: "0.1.0",
});

registerTools(server);

async function main() {
  await initSentry();

  // Redirect stderr to log file (stdout is reserved for MCP JSON-RPC protocol)
  if (!fs.existsSync(FML_LOG_DIR)) {
    fs.mkdirSync(FML_LOG_DIR, { recursive: true });
  }
  const logFd = fs.openSync(LOG_PATH, "a");
  const logStream = fs.createWriteStream("", { fd: logFd });
  process.stderr.write = logStream.write.bind(
    logStream,
  ) as typeof process.stderr.write;

  // Check auth state and surface setup prompts
  const tokens = readTokens();
  const tokenValid = tokens ? await getValidToken() : null;

  if (!tokens) {
    const storePath = authStorePath();
    try {
      const files = fs.readdirSync(FML_DATA_DIR).join(", ") || "(empty)";
      console.error(
        `[fml] No auth file at ${storePath}. Dir contents: ${files}`,
      );
    } catch {
      console.error(`[fml] No auth file at ${storePath}. Dir not readable.`);
    }
    server.resource("setup", "fml://setup", async () => ({
      contents: [
        {
          uri: "fml://setup",
          text: "FML plugin is not authenticated. Run `fml login` in your terminal to sign in, then restart Claude Code.",
        },
      ],
    }));
    console.error("[fml] Not authenticated — run `fml login`");
  } else if (!tokenValid) {
    console.error("[fml] Token expired — run `fml login` to re-authenticate");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Ensure panopticon is running (includes sync, which handles config snapshots)
  if (!parsePanopticonRunning()) {
    try {
      const { handlePanopticonStart } = await import("../commands/daemon.js");
      await handlePanopticonStart();
    } catch {
      console.error(
        "[fml] Warning: could not start panopticon. Run `fml start` manually",
      );
    }
  }
}

main().catch((err) => {
  Sentry.captureException(err);
  console.error("FML MCP server error:", err);
  process.exit(1);
});
