// Vercel serverless function: read-only /api/tool over the bundled scoped DB.
// Mirrors scripts/serve-snapshot.mjs. Reuses the same service dispatch the live
// server uses, so the public snapshot is fully queryable. Writes (/api/exec) are
// intentionally not exposed.
import path from "node:path";

// config reads PANOPTICON_DATA_DIR at import — point it at the bundled DB before
// importing the service. (Set in the Vercel project env too if you relocate it.)
process.env.PANOPTICON_DATA_DIR ||= path.join(
  process.cwd(),
  "apps",
  "static-site",
  "db",
);

const { dispatchTool, directPanopticonService, isToolName } = await import(
  "../dist/service/index.js"
);

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const { name, params } = req.body ?? {};
  if (!isToolName(name)) {
    res.status(404).json({ error: `unknown tool: ${name}` });
    return;
  }
  try {
    const result = await dispatchTool(
      directPanopticonService,
      name,
      params ?? {},
    );
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
