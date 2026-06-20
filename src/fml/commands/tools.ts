import { readFileSync } from "node:fs";
import path from "node:path";
import {
  getAuthenticatedClient,
  type PublicToolDescriptor,
} from "../fml-client.js";

declare const __FML_PLUGIN_VERSION__: string;
const pluginVersion =
  typeof __FML_PLUGIN_VERSION__ !== "undefined"
    ? __FML_PLUGIN_VERSION__
    : undefined;

async function getApi() {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  return api;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const curr = [i + 1];
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      curr.push(Math.min(curr[j]! + 1, prev[j + 1]! + 1, prev[j]! + cost));
    }
    prev = curr;
  }
  return prev[b.length]!;
}

function closestMatches(
  name: string,
  descriptors: PublicToolDescriptor[],
): string[] {
  const threshold = Math.max(2, Math.ceil(name.length * 0.4));
  return descriptors
    .map((d) => ({
      name: d.name,
      // Substring match always beats fuzzy match.
      score: d.name.includes(name) ? 0 : levenshtein(name, d.name),
    }))
    .filter((m) => m.score <= threshold)
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((m) => m.name);
}

function findOrSuggestExit(
  name: string,
  descriptors: PublicToolDescriptor[],
): PublicToolDescriptor {
  const descriptor = descriptors.find((d) => d.name === name);
  if (descriptor) return descriptor;
  console.error(`Unknown tool: ${name}`);
  const suggestions = closestMatches(name, descriptors);
  if (suggestions.length > 0) {
    console.error(`Did you mean: ${suggestions.join(", ")}?`);
  }
  process.exit(1);
}

export async function handleToolsList(opts: {
  category?: string;
  json?: boolean;
}): Promise<void> {
  const api = await getApi();
  let descriptors = await api.listTools(pluginVersion);

  if (opts.category) {
    descriptors = descriptors.filter((d) => d.category === opts.category);
  }

  if (opts.json) {
    console.log(JSON.stringify(descriptors, null, 2));
    return;
  }

  if (descriptors.length === 0) {
    console.log("No tools found.");
    return;
  }

  console.log("Backend tools available to this FML session.\n");
  console.log("Next steps:");
  console.log("  fml tools describe <tool> --json        Inspect args/schema");
  console.log("  fml tools call <tool> --args '{...}'   Run a tool");
  console.log(
    "  fml tools list --json                  Machine-readable catalog",
  );
  console.log("");

  const nameW = Math.min(
    40,
    Math.max(...descriptors.map((d) => d.name.length), 4),
  );
  const catW = 14;
  const header =
    "name".padEnd(nameW) +
    "  " +
    "category".padEnd(catW) +
    "  " +
    "description";
  const divider = "-".repeat(header.length);
  console.log(header);
  console.log(divider);
  for (const d of descriptors) {
    const cat = d.category ?? "";
    const suffix = d.experimental ? " (experimental)" : "";
    const desc = (d.description + suffix).slice(0, 80);
    console.log(`${d.name.padEnd(nameW)}  ${cat.padEnd(catW)}  ${desc}`);
  }
}

export async function handleToolsDescribe(
  name: string,
  opts: { json?: boolean },
): Promise<void> {
  const api = await getApi();
  const descriptors = await api.listTools(pluginVersion);
  const descriptor = findOrSuggestExit(name, descriptors);

  if (opts.json) {
    console.log(JSON.stringify(descriptor, null, 2));
    return;
  }

  console.log(`Name:        ${descriptor.name}`);
  if (descriptor.category) console.log(`Category:    ${descriptor.category}`);
  if (descriptor.experimental) console.log(`Experimental: true`);
  console.log(`\nDescription:\n  ${descriptor.description}`);
  console.log(
    `\nInput schema:\n${JSON.stringify(descriptor.inputSchema, null, 2)}`,
  );
}

export async function handleToolsCall(
  name: string,
  opts: { args?: string; file?: string },
): Promise<void> {
  if (opts.args !== undefined && opts.file !== undefined) {
    console.error("Error: --args and --file are mutually exclusive.");
    process.exit(1);
  }

  const raw = opts.file
    ? (() => {
        try {
          return readFileSync(path.resolve(opts.file), "utf8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Could not read args file: ${msg}`);
          process.exit(1);
        }
      })()
    : (opts.args ?? "{}");

  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Invalid JSON in ${opts.file ? "--file" : "--args"}: ${msg}`);
    process.exit(1);
  }

  const api = await getApi();
  const descriptors = await api.listTools(pluginVersion);
  // Resolve the tool exists locally so the user gets a "did you mean" hint
  // before we round-trip to the backend. The backend is the authoritative
  // validator for argument shape (we deliberately don't duplicate that here).
  findOrSuggestExit(name, descriptors);

  const result = await api.callBackend(name, parsedArgs);
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }

  console.log(JSON.stringify(result.result, null, 2));
}
