import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const RUN_HEADLESS_SMOKE = /^(1|true|yes|on)$/i.test(
  process.env.PANOPTICON_PI_HEADLESS_SMOKE ?? "",
);
const SMOKE_TIMEOUT_MS = Number.parseInt(
  process.env.PANOPTICON_PI_HEADLESS_SMOKE_TIMEOUT_MS ?? "120000",
  10,
);

const cleanupDirs: string[] = [];
const restorers: Array<() => void> = [];
const envRestorers: Array<() => void> = [];

function setEnvForTest(key: string, value: string): void {
  const previous = process.env[key];
  process.env[key] = value;
  envRestorers.push(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function waitForListening(server: http.Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      const address = server.address();
      if (typeof address === "object" && address) resolve(address.port);
      else reject(new Error("server did not expose a TCP port"));
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function waitFor<T>(
  query: () => T,
  accept: (value: T) => boolean,
  timeoutMs = 15000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = query();
  while (Date.now() < deadline) {
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = query();
  }
  return last;
}

function installSmokeExtension(home: string): boolean {
  const source = path.resolve("dist", "targets", "pi", "extension.js");
  if (!fs.existsSync(source)) return false;

  const dest = path.join(home, ".pi", "agent", "extensions", "panopticon.js");
  const backup = fs.existsSync(dest)
    ? fs.readFileSync(dest, "utf8")
    : undefined;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  restorers.push(() => {
    if (backup === undefined) fs.rmSync(dest, { force: true });
    else fs.writeFileSync(dest, backup);
  });
  return true;
}

async function runPiPrompt(
  prompt: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn("pi", ["-p", prompt], { cwd, env });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`pi -p timed out after ${SMOKE_TIMEOUT_MS}ms`));
      }, SMOKE_TIMEOUT_MS);
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    },
  );
}

afterEach(() => {
  while (envRestorers.length > 0) envRestorers.pop()?.();
  while (restorers.length > 0) restorers.pop()?.();
  for (const dir of cleanupDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!RUN_HEADLESS_SMOKE)("gated headless Pi smoke", () => {
  it(
    "runs pi -p and records prompt, hooks, paths, messages, and tool calls",
    async () => {
      if (process.env.CI && !process.env.PANOPTICON_PI_HEADLESS_SMOKE_CI) {
        console.warn(
          "Skipping headless Pi smoke in CI without PANOPTICON_PI_HEADLESS_SMOKE_CI=1",
        );
        return;
      }
      if (spawnSync("pi", ["--version"], { encoding: "utf8" }).error) {
        console.warn("Skipping headless Pi smoke: pi binary is not available");
        return;
      }

      const home =
        process.env.PANOPTICON_PI_HEADLESS_SMOKE_HOME ?? os.homedir();
      if (!installSmokeExtension(home)) {
        console.warn(
          "Skipping headless Pi smoke: dist/targets/pi/extension.js is missing; run pnpm build first",
        );
        return;
      }

      const dataDir = makeTempDir("pano-pi-headless-data-");
      const workDir = makeTempDir("pano-pi-headless-work-");
      const smokeFile = path.join(workDir, "pi-headless-smoke.txt");
      const authToken = "pi-headless-smoke-token";
      setEnvForTest("PANOPTICON_DATA_DIR", dataDir);
      setEnvForTest("PANOPTICON_AUTH_TOKEN", authToken);
      setEnvForTest("PANOPTICON_HOST", "127.0.0.1");

      const { createUnifiedServer } = await import("../server.js");
      const { getDb, closeDb } = await import("../db/schema.js");
      const server = createUnifiedServer();
      const port = await waitForListening(server, "127.0.0.1");
      setEnvForTest("PANOPTICON_PORT", String(port));

      try {
        const env = {
          ...process.env,
          HOME: home,
          PANOPTICON_DATA_DIR: dataDir,
          PANOPTICON_AUTH_TOKEN: authToken,
          PANOPTICON_HOST: "127.0.0.1",
          PANOPTICON_PORT: String(port),
          PANOPTICON_PI_SHUTDOWN_FLUSH_TIMEOUT_MS: "10000",
        };
        const prompt = `Create the file ${smokeFile} with exactly this content: panopticon pi headless smoke`;
        const result = await runPiPrompt(prompt, workDir, env);
        if (result.code !== 0) {
          console.warn(
            `Skipping headless Pi smoke: pi -p exited ${result.code}. stderr: ${result.stderr.slice(0, 1000)}`,
          );
          return;
        }

        const db = getDb();
        const counts = await waitFor(
          () =>
            db
              .prepare(
                `SELECT
                  (SELECT COUNT(*) FROM sessions WHERE target = 'pi') AS sessions,
                  (SELECT COUNT(*) FROM sessions WHERE target = 'pi' AND first_prompt LIKE '%pi headless smoke%') AS prompts,
                  (SELECT COUNT(*) FROM hook_events WHERE target = 'pi') AS hooks,
                  (SELECT COUNT(*) FROM hook_events WHERE target = 'pi' AND file_path = ?) AS paths,
                  (SELECT COUNT(*)
                   FROM messages m
                   JOIN sessions s ON s.session_id = m.session_id
                   WHERE s.target = 'pi') AS messages,
                  (SELECT COUNT(*)
                   FROM tool_calls tc
                   JOIN sessions s ON s.session_id = tc.session_id
                   WHERE s.target = 'pi') AS toolCalls`,
              )
              .get(smokeFile) as {
              sessions: number;
              prompts: number;
              hooks: number;
              paths: number;
              messages: number;
              toolCalls: number;
            },
          (row) =>
            row.sessions > 0 &&
            row.prompts > 0 &&
            row.hooks > 0 &&
            row.paths > 0 &&
            row.messages > 0 &&
            row.toolCalls > 0,
        );

        expect(counts.sessions).toBeGreaterThan(0);
        expect(counts.prompts).toBeGreaterThan(0);
        expect(counts.hooks).toBeGreaterThan(0);
        expect(counts.paths).toBeGreaterThan(0);
        expect(counts.messages).toBeGreaterThan(0);
        expect(counts.toolCalls).toBeGreaterThan(0);
      } finally {
        await closeServer(server);
        closeDb();
      }
    },
    SMOKE_TIMEOUT_MS + 30000,
  );
});
