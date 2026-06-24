Deprecated compatibility command. Route through `/fml` for all new workflows.

Translate these arguments to the FML command surface:

```
$ARGUMENTS
```

Use the `fml` skill and FML MCP tools. Treat `/panopticon <args>` as `/fml <args>` when the subcommand exists on FML, and prefer FML local MCP tools or `fml <command> --local` for local data.

Only use the `panopticon` CLI as an explicit compatibility fallback for local collection internals that FML has not exposed yet. Do not route through Panopticon MCP.

For `panopticon review`, run the `fml review` workflow. Do not use the legacy `panopticon-review` or `pr-review` command/skill names.
