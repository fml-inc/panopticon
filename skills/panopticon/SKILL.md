---
name: panopticon
description: Deprecated compatibility shim for Panopticon command-style requests. Use the FML skill, FML MCP tools, and the `fml` CLI for /panopticon, $panopticon, local session data, timelines, costs, summaries, plans, search, SQL, file provenance, permissions, lifecycle status, sync operations, and review workflows.
---

# Panopticon Compatibility Shim

Panopticon is now the local collection engine behind FML. Do not route new work through Panopticon MCP. Translate `/panopticon <args>` and `$panopticon <args>` to the FML command surface.

## Routing

1. Use the `fml` skill for command parsing, safety rules, MCP selection, local data reads, synced data reads, lifecycle operations, and review workflows.
2. Prefer FML MCP tools, including `fml_local_*` tools for local/unsynced data.
3. Use the `fml` CLI for lifecycle, install/uninstall/update, login/logout, doctor, sync setup, and commands not exposed as FML MCP tools.
4. Use the `panopticon` CLI only as an explicit compatibility fallback for local collection internals that FML has not exposed yet.
5. Do not use or recommend Panopticon MCP tools.

## Common Translations

| Panopticon request | Route |
| --- | --- |
| `panopticon sessions` | `fml sessions --local` or MCP `fml_local_sessions` |
| `panopticon timeline <id>` | `fml timeline <id> --local` or MCP `fml_local_timeline` |
| `panopticon search <query>` | `fml search <query> --local` or MCP `fml_local_search` |
| `panopticon costs` | `fml spending --local` or MCP `fml_local_spending` |
| `panopticon plans` | MCP `fml_local_plans` |
| `panopticon query <sql>` | MCP `fml_local_query`; only read-only SQL is allowed |
| `panopticon file why|recent|overview ...` | FML local provenance MCP tools |
| `panopticon status|doctor|start|stop|install|uninstall|update|sync ...` | `fml` CLI when available; Panopticon CLI only for missing internals |
| `panopticon review` | Run the `fml review` workflow |

If a direct translation is unavailable, fall back to `fml local <args...>` and say that the local Panopticon engine is being used through FML compatibility.
