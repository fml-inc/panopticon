# Issue Draft: codex exec on Windows spawns visible PowerShell helper window

## Title

`codex exec` on Windows spawns a visible long-lived PowerShell helper window when launched headlessly

## Body

### What is the problem?

We are running Codex from another tool in a headless/background mode using `codex exec` on Windows. The parent process launches Codex with `windowsHide: true` and avoids the npm `.cmd` shim by invoking the Codex JavaScript entrypoint through `node.exe` directly.

Despite that, a visible PowerShell window appears. One of these windows can remain open for the lifetime of the active Codex process.

The visible window appears to come from a PowerShell helper spawned by Codex itself, not from the parent application that launches Codex.

### Why this matters

`codex exec` is documented and exposed as a non-interactive/headless mode. In background automation on Windows, it should not open visible terminal windows. This is especially disruptive for installed services, hooks, daemons, editors, or other tools that call Codex in the background.

Because this PowerShell process is a grandchild of the caller, the caller cannot reliably apply `windowsHide` to it. The process that spawns the helper needs to request hidden/no-window creation on Windows.

### Environment

- OS: Windows
- Invocation mode: `codex exec`
- Parent application launch behavior:
  - Uses Node `spawn`
  - Uses `windowsHide: true`
  - Uses `stdio: ["ignore", "pipe", "pipe"]`
  - Avoids npm `.cmd` shim by resolving to the Codex JS entrypoint and invoking it with `node.exe`

### Observed process tree

The long-lived visible PowerShell process was parented by `codex.exe`, not by the parent application:

```text
powershell.exe
  CommandLine: C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ...
  Parent: codex.exe
```

The decoded command describes the process as:

```text
Long-lived PowerShell AST parser used by the Rust command-safety layer on Windows.
```

### Expected behavior

When `codex exec` is used non-interactively on Windows, Codex should not create visible console windows for internal helper processes.

Possible fixes:

- Spawn the Windows PowerShell AST/helper process with hidden/no-window creation flags.
- Provide a mode for `codex exec` that does not start shell/tool command-safety helper processes when the caller only needs prompt-only non-interactive behavior.

### Actual behavior

`codex exec` can spawn a visible PowerShell helper window. When Codex is launched by a background enrichment process, this makes background work visible to the desktop user and can leave a PowerShell window open.

### Reproduction shape

1. On Windows, launch Codex from a Node process using `spawn`.
2. Set `windowsHide: true`.
3. Invoke `codex exec` non-interactively.
4. Observe that Codex may spawn a visible `powershell.exe` child for its Windows command-safety layer.

The key point is that the visible window is spawned by Codex itself, so hiding the original `codex exec` process from the parent application is not enough.
