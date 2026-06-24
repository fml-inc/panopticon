import { execSync } from "node:child_process";
import { Sentry } from "../sentry.js";

declare const __FML_PLUGIN_VERSION__: string;

export async function handleUpdate(): Promise<void> {
  const currentVersion =
    typeof __FML_PLUGIN_VERSION__ !== "undefined"
      ? __FML_PLUGIN_VERSION__
      : "unknown";

  console.log(`Current: ${currentVersion}`);
  console.log("Updating via npm...\n");

  try {
    const env = { ...process.env };
    delete env.npm_config_registry;

    execSync("npm install -g @fml-inc/panopticon@latest", {
      stdio: "inherit",
      timeout: 120_000,
      env,
    });

    console.log("\nUpdated. Run `fml install --force` to reconfigure.");
  } catch (err: unknown) {
    Sentry.captureException(err);
    const msg =
      err instanceof Error
        ? ((err as Error & { stderr?: Buffer }).stderr?.toString() ??
          err.message)
        : String(err);
    console.error("Update failed:", msg);
    process.exit(1);
  }
}
