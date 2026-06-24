---
description: Route FML CLI requests to MCP tools or the fml CLI
---

<!-- fml-managed-agent-surface:v1 -->

Use the FML command router for these arguments:

```
$ARGUMENTS
```

Route the request through the `fml` skill installed alongside this command. Treat `/fml <args>`, `$fml <args>`, and natural-language requests to run FML commands as the same command surface.

If the user asks for local/unsynced data or includes `--local`, keep them on FML vocabulary: use `fml <command> --local` for common read commands or `fml local <args...>` for local passthrough.

If the first argument is `review`, read the skill's `references/review.md` and follow that PR review workflow.

If the arguments are empty, show concise help and prefer a lightweight `fml status` or `fml commands` lookup only if the user asked for current state or command inventory.

The `panopticon` command remains available only as a deprecated compatibility alias while existing installs migrate to FML.
