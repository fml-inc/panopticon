import os from "node:os";
import path from "node:path";

export function piDir(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".pi");
}

export function piAgentDir(): string {
  return path.join(piDir(), "agent");
}

export function agentsDir(): string {
  return path.join(process.env.HOME ?? os.homedir(), ".agents");
}
