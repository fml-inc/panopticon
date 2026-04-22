/** Split a command string on chain operators (&&, ||, ;, |). */
export function splitChainComponents(cmd: string): string[] {
  return cmd
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Detect shell expansions that escape the base-command check:
 *   $(cmd)  — POSIX command substitution
 *   `cmd`   — legacy command substitution
 *   <(cmd)  — bash process substitution (input)
 *   >(cmd)  — bash process substitution (output)
 *
 * splitChainComponents only knows about chain operators, so without this
 * guard `approved-cmd "$(rm -rf ~)" && approved-cmd2` would auto-approve:
 * both components have approved base commands, and the subshell is never
 * inspected.
 *
 * Quote-context detection (e.g., recognizing that `'$(foo)'` is literal
 * inside single quotes) would require a real shell parser. Conservatively
 * rejecting any occurrence is safer — false positives just fall through
 * to manual approval, which is the existing default for unrecognized input.
 */
export function containsShellExpansion(cmd: string): boolean {
  return /\$\(|`|<\(|>\(/.test(cmd);
}

/**
 * Extract all base commands from a single (non-chain) command string.
 * Returns multiple commands when the primary command delegates to others
 * (e.g., `find -exec rm` returns ["find", "rm"]).
 */
export function extractBaseCommands(component: string): string[] {
  // Strip leading env var assignments (FOO=bar cmd → cmd)
  let cmd = component.replace(/^(?:[A-Z_][A-Z0-9_]*=[^\s]*\s+)+/, "");
  // Strip trailing redirections (2>&1, >/dev/null, etc.)
  cmd = cmd.replace(/\s*\d*>[>&]?\s*\S+/g, " ").trim();
  cmd = cmd.replace(/\s*\d*<\s*\S+/g, " ").trim();

  const tokens = cmd.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  // Shell re-entry: bash -c / sh -c are arbitrary execution
  if ((tokens[0] === "bash" || tokens[0] === "sh") && tokens.includes("-c")) {
    return [tokens[0]];
  }

  // For compound CLI tools, skip flags to find the real subcommand.
  // The result is "{tool} {subcommand}" (e.g., "git status", "xargs grep").
  const COMPOUND_TOOLS: Record<string, Set<string>> = {
    git: new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]),
    gh: new Set(["-R", "--repo"]),
    npx: new Set(["-p", "--package"]),
    pnpm: new Set(["--filter", "-C", "--dir"]),
    xargs: new Set([
      "-I",
      "-L",
      "-n",
      "-P",
      "-s",
      "--max-args",
      "--max-procs",
      "--replace",
    ]),
    env: new Set([]),
    nice: new Set(["-n", "--adjustment"]),
    timeout: new Set(["-k", "--kill-after", "-s", "--signal"]),
    watch: new Set(["-n", "-d", "--interval"]),
  };
  const flagsWithArg = COMPOUND_TOOLS[tokens[0]];
  if (flagsWithArg && tokens.length > 1) {
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.startsWith("-")) {
        if (flagsWithArg.has(t) && !t.includes("=")) i++;
        continue;
      }
      // env: skip VAR=val assignments
      if (t.includes("=") && tokens[0] === "env") continue;
      // timeout: first positional arg is the duration, skip it
      if (tokens[0] === "timeout" && /^\d/.test(t)) continue;
      return [`${tokens[0]} ${t}`];
    }
    return [tokens[0]];
  }

  const baseCmd = tokens[0];
  const results = [baseCmd];

  // find -exec / -execdir: extract the delegated command
  if (baseCmd === "find") {
    for (let i = 1; i < tokens.length; i++) {
      if (tokens[i] === "-exec" || tokens[i] === "-execdir") {
        const delegated = tokens[i + 1];
        if (delegated && delegated !== "{}" && delegated !== ";") {
          // Extract just the binary name (strip any path prefix)
          const binName = delegated.split("/").pop()!;
          results.push(binName);
        }
      }
    }
  }

  return results;
}

/** Extract the base command from a single (non-chain) command string. */
export function extractBaseCommand(component: string): string {
  return extractBaseCommands(component)[0] ?? "";
}

/**
 * Check if a Bash command should be auto-approved.
 * Returns an allow decision only when ALL chain components match.
 * Returns null to fall through to Claude Code's normal prompting.
 */
export function checkBashPermission(
  command: string,
  allowedCommands: string[],
): { allow: true; reason: string } | null {
  if (!allowedCommands.length) return null;

  // Refuse to auto-approve when the command contains shell expansions
  // ($(...), backticks, <(...), >(...)). These can hide arbitrary commands
  // inside an otherwise-approved wrapper.
  if (containsShellExpansion(command)) return null;

  const components = splitChainComponents(command);
  if (components.length === 0) return null;

  const bases = components.flatMap(extractBaseCommands);
  const unapproved = bases.filter((b) => !allowedCommands.includes(b));

  if (unapproved.length === 0) {
    return {
      allow: true,
      reason: `All ${bases.length} component(s) approved: ${bases.join(", ")}`,
    };
  }
  return null;
}
