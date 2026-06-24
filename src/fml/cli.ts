#!/usr/bin/env node

declare const __FML_PLUGIN_VERSION__: string;

import { Command } from "commander";
import { printBanner } from "./banner.js";
import {
  handleRunAnalysis,
  handleRunTeamAnalysis,
  handleSearchAnalysis,
} from "./commands/analysis.js";
import {
  handleAutomationCreate,
  handleAutomationCreatePattern,
  handleAutomationDelete,
  handleAutomationList,
  handleAutomationTest,
  handleAutomationUpdate,
} from "./commands/automation.js";
import {
  handleConfigDetail,
  handleConfigList,
} from "./commands/config-snapshots.js";
import {
  handleFmlStart,
  handleFmlStop,
  handlePanopticonStart,
  handlePanopticonStop,
  handleSyncStart,
  handleSyncStop,
} from "./commands/daemon.js";
import {
  handleActivity,
  handleSearch,
  handleSessions,
  handleSpending,
  handleTimeline,
} from "./commands/data.js";
import { handleDoctor } from "./commands/doctor.js";
import { handleEnvShow, handleEnvSwitch } from "./commands/env.js";
import { handleInstall } from "./commands/install.js";
import {
  handleEvents,
  handleIntegrations,
  handleResolveIdentity,
} from "./commands/integrations.js";
import { handleLocal } from "./commands/local.js";
import { handleLogin } from "./commands/login.js";
import { handleLogout } from "./commands/logout.js";
import {
  handleMemoryDelete,
  handleMemoryList,
  handleMemoryRead,
  handleMemoryWrite,
} from "./commands/memory.js";
import {
  handleMessagesContext,
  handleMessagesList,
} from "./commands/messages.js";
import { handleOpen } from "./commands/open.js";
import { handleOrg } from "./commands/org.js";
import { handleQuery } from "./commands/query.js";
import { handleSkillsList, handleSkillsLoad } from "./commands/skills.js";
import { handleSlackHistory, handleSlackMessage } from "./commands/slack.js";
import { handleStatus } from "./commands/status.js";
import {
  handleSyncAdd,
  handleSyncEdit,
  handleSyncList,
  handleSyncRemove,
  handleSyncReset,
  handleSyncSetup,
  handleSyncStatus,
} from "./commands/sync.js";
import { handleSyncToken } from "./commands/sync-token.js";
import {
  handleToolsCall,
  handleToolsDescribe,
  handleToolsList,
} from "./commands/tools.js";
import { handleUninstall } from "./commands/uninstall.js";
import { handleUpdate } from "./commands/update.js";
import { initSentry, Sentry } from "./sentry.js";

await initSentry();

// Show the logo when running `fml` with no args or `fml --help`
if (
  process.argv.length <= 2 ||
  process.argv.includes("--help") ||
  process.argv.includes("-h")
) {
  printBanner();
}

const program = new Command()
  .name("fml")
  .description("FML CLI and agent tools")
  .version(
    typeof __FML_PLUGIN_VERSION__ !== "undefined"
      ? __FML_PLUGIN_VERSION__
      : "dev",
  );

function formatCommandInventory(cmd: typeof program, prefix = "") {
  const name = prefix ? `${prefix} ${cmd.name()}` : cmd.name();
  const args = cmd.registeredArguments
    .map((a) => {
      const argName = a.variadic ? `${a.name()}...` : a.name();
      return a.required ? `<${argName}>` : `[${argName}]`;
    })
    .join(" ");
  const opts = cmd.options
    .filter((o) => !o.hidden && o.long !== "--help" && o.long !== "--version")
    .map((o) => (o.mandatory ? o.flags : `[${o.flags}]`))
    .join(" ");
  const usage = [name, args, opts].filter(Boolean).join(" ");
  return `${usage}\n  ${cmd.description()}`;
}

const tools = program
  .command("tools")
  .description("List backend tools available via the dynamic catalog")
  .option("--category <category>", "Filter by category")
  .option("--json", "Output as JSON")
  .action((opts) => handleToolsList(opts));

program
  .command("commands", { hidden: true })
  .description("List CLI commands, including hidden/internal commands")
  .action(() => {
    const lines = program.commands
      .filter((c) => c.name() !== "commands" && c.name() !== "help")
      .flatMap((c) => {
        if (c.commands.length > 0) {
          return c.commands.map((s) => formatCommandInventory(s, c.name()));
        }
        return [formatCommandInventory(c)];
      });
    console.log(lines.join("\n\n"));
  });

tools
  .command("list")
  .description("List backend tools available via the dynamic catalog")
  .option("--category <category>", "Filter by category")
  .option("--json", "Output as JSON")
  .action((opts) => handleToolsList(opts));

tools
  .command("describe")
  .description("Show description and input schema for a backend tool")
  .argument("<name>", "Tool name (e.g. integration-github)")
  .option("--json", "Output as JSON")
  .action((name, opts) => handleToolsDescribe(name, opts));

tools
  .command("call")
  .description("Invoke a backend tool by name with JSON args")
  .argument("<name>", "Tool name")
  .option("--args <json>", "Args as a JSON string (defaults to {})")
  .option("--file <path>", "Path to a JSON file containing args")
  .action((name, opts) => handleToolsCall(name, opts));

program
  .command("install")
  .description("Set up FML for local agent use")
  .option(
    "--force",
    "Reinstall local collection and re-register the FML plugin",
  )
  .action((opts) => handleInstall(opts));

program
  .command("uninstall")
  .description("Remove FML agent integrations and optionally local data")
  .option(
    "--target <target>",
    "Target CLI: claude, gemini, codex, claude-desktop, all",
  )
  .option("--purge", "Also remove all data, logs, and auth tokens")
  .action((opts) => handleUninstall(opts));

program
  .command("update")
  .description("Update fml to the latest version")
  .action(() => handleUpdate());

program
  .command("login")
  .description("Sign in to your FML account")
  .option("--device", "Use device authorization flow (no browser needed)")
  .option(
    "--service-token",
    "Sign in with an org service refresh token (prompts for fml_srt_*)",
  )
  .action((opts: { device?: boolean; serviceToken?: boolean }) =>
    handleLogin(opts),
  );

program
  .command("logout")
  .description("Sign out and clear stored credentials")
  .action(() => handleLogout());

program
  .command("org")
  .description("Show or select organization")
  .argument("[slug]", "Org slug to select")
  .action((slug) => handleOrg(slug));

program
  .command("status")
  .description("Show auth and local service status")
  .action(() => handleStatus());

program
  .command("local")
  .description("Run a local Panopticon command through FML")
  .argument("[args...]", "Panopticon command and arguments")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action((args: string[]) => handleLocal(args));

program
  .command("doctor")
  .description("Check FML and panopticon configuration and connectivity")
  .option("--json", "Output as JSON")
  .action((opts) => handleDoctor(opts));

program
  .command("open")
  .description("Open FML dashboard in browser")
  .option("--json", "Output URL as JSON instead of opening browser")
  .action((opts) => handleOpen(opts));

program
  .command("env")
  .description("Show or switch FML backend environment")
  .argument("[target]", "Environment name or backend URL")
  .action((target?: string) => {
    if (target) return handleEnvSwitch(target);
    handleEnvShow();
  });

// ── Panopticon server lifecycle ─────────────────────────────────────────────

program
  .command("start")
  .description("Start FML local collection and sync")
  .action(() => handleFmlStart());

program
  .command("stop")
  .description("Stop FML local collection and sync")
  .action(() => handleFmlStop());

const panopticon = program
  .command("panopticon", { hidden: true })
  .description("Start or stop the panopticon server");

panopticon
  .command("start")
  .description("Start the panopticon server")
  .action(() => handlePanopticonStart());

panopticon
  .command("stop")
  .description("Stop the panopticon server")
  .action(() => handlePanopticonStop());

// ── Sync subcommand ───────────────────────────────────────────────────────

const sync = program
  .command("sync")
  .description("Manage sync configuration and troubleshooting");

sync
  .command("start")
  .description("Start syncing to configured targets (enable sync)")
  .action(() => handleSyncStart());

sync
  .command("stop")
  .description("Stop syncing (disable sync; leaves targets configured)")
  .action(() => handleSyncStop());

sync
  .command("setup")
  .description("Configure sync targets (convenience shortcut)")
  .action(() => handleSyncSetup());

sync
  .command("list")
  .description("List all sync targets")
  .action(() => handleSyncList());

sync
  .command("add")
  .description("Add a sync target")
  .argument("<name>", "Unique target name")
  .argument("<url>", "OTLP HTTP endpoint URL")
  .option("--token-cmd <cmd>", "Shell command that returns a bearer token")
  .option("--token <token>", "Static bearer token")
  .action(
    (name: string, url: string, opts: { tokenCmd?: string; token?: string }) =>
      handleSyncAdd(name, url, opts),
  );

sync
  .command("remove")
  .description("Remove a sync target")
  .argument("<name>", "Target name to remove")
  .action((name: string) => handleSyncRemove(name));

sync
  .command("edit")
  .description("Edit a sync target")
  .argument("<name>", "Target name to edit")
  .option("--url <url>", "New OTLP HTTP endpoint URL")
  .option("--token-cmd <cmd>", "New shell command for bearer token")
  .option("--token <token>", "New static bearer token")
  .action(
    (name: string, opts: { url?: string; tokenCmd?: string; token?: string }) =>
      handleSyncEdit(name, opts),
  );

sync
  .command("status")
  .description("Show sync config and watermarks")
  .action(() => handleSyncStatus());

sync
  .command("reset")
  .description("Reset sync watermarks")
  .argument("[name]", "Target name (resets all if omitted)")
  .action((name?: string) => handleSyncReset(name));

program
  .command("sync-token", { hidden: true })
  .description(
    "Print a refreshed FML access token (for panopticon tokenCommand)",
  )
  .option(
    "--env <name>",
    "Read auth for a specific env (defaults to active env)",
  )
  .action((opts: { env?: string }) => handleSyncToken(opts));

// ── Data commands ───────────────────────────────────────────────────────────

program
  .command("activity")
  .description("Activity summary — sessions, prompts, tools, costs")
  .option("--since <duration>", 'Time window, e.g. "24h", "7d"')
  .option("--local", "Query local Panopticon data instead of FML cloud")
  .action((opts) => handleActivity(opts));

program
  .command("sessions")
  .description("List recent sessions")
  .option("--since <duration>", 'Time filter, e.g. "24h", "7d"')
  .option("--limit <n>", "Max sessions to return")
  .option("--local", "Query local Panopticon data instead of FML cloud")
  .action((opts) => handleSessions(opts));

program
  .command("timeline")
  .description("Get events for a session from `fml sessions`")
  .argument("<session-id>", "Session ID from `fml sessions`")
  .option("--limit <n>", "Max events to return")
  .option("--offset <n>", "Events to skip")
  .option("--full", "Local only: return full content instead of truncated")
  .option("--local", "Query local Panopticon data instead of FML cloud")
  .action((sessionId, opts) => handleTimeline(sessionId, opts));

program
  .command("spending")
  .description("AI token usage and cost breakdown")
  .option("--since <duration>", 'Time filter, e.g. "24h", "7d"')
  .option("--group-by <key>", "Group by: session, model, or day")
  .option("--local", "Query local Panopticon data instead of FML cloud")
  .action((opts) => handleSpending(opts));

program
  .command("search")
  .description("Search FML agent sessions")
  .argument("<query>", "Text to search for")
  .option("--since <duration>", 'Time filter, e.g. "24h", "7d"')
  .option("--limit <n>", "Max results")
  .option("--offset <n>", "Local only: events to skip")
  .option("--full", "Local only: return full payloads instead of truncated")
  .option("--local", "Query local Panopticon data instead of FML cloud")
  .action((query, opts) => handleSearch(query, opts));

// ── Query command (unified integration queries) ────────────────────────────

program
  .command("query", { hidden: true })
  .description("Query a connected integration")
  .argument(
    "<provider>",
    "Provider name (sentry, slack, github, linear, notion, freshdesk, stripe, posthog, amplitude, meta-ads)",
  )
  .argument("<endpoint>", "API endpoint or subcommand")
  .option("--method <method>", "HTTP method", "GET")
  .option("--body <json>", "Request body as JSON string")
  .option("--project-id <id>", "Project ID override")
  .action((provider, endpoint, opts) => handleQuery(provider, endpoint, opts));

// ── Automation subcommand ──────────────────────────────────────────────────

const automation = program
  .command("automation", { hidden: true })
  .description("Manage automations");

automation
  .command("list")
  .description("List all automations")
  .action(() => handleAutomationList());

automation
  .command("create-scheduled")
  .description("Create a scheduled automation")
  .requiredOption("--name <name>", "Automation name")
  .requiredOption("--prompt <prompt>", "What to run")
  .requiredOption("--frequency <freq>", "hourly, daily, weekly, or monthly")
  .requiredOption("--hour <hour>", "Hour (0-23)")
  .requiredOption("--minute <minute>", "Minute (0-59)")
  .requiredOption("--timezone <tz>", "IANA timezone, e.g. America/Chicago")
  .option("--day-of-week <day>", "Day of week (0=Sun..6=Sat) for weekly")
  .option("--day-of-month <day>", "Day of month (1-31) for monthly")
  .option("--max-runs <n>", "Max runs (1 for one-time)")
  .action((opts) => handleAutomationCreate(opts));

automation
  .command("create-pattern")
  .description("Create an event-triggered automation")
  .requiredOption("--name <name>", "Automation name")
  .requiredOption("--prompt <prompt>", "What to watch for and do")
  .action((opts) => handleAutomationCreatePattern(opts));

automation
  .command("update")
  .description("Update an automation")
  .argument("<id>", "Automation ID")
  .option("--name <name>", "New name")
  .option("--prompt <prompt>", "New prompt")
  .option("--enabled <bool>", "Enable or disable (true/false)")
  .option("--frequency <freq>", "New frequency")
  .option("--hour <hour>", "New hour")
  .option("--minute <minute>", "New minute")
  .option("--timezone <tz>", "New timezone")
  .option("--day-of-week <day>", "New day of week")
  .option("--day-of-month <day>", "New day of month")
  .action((id, opts) => handleAutomationUpdate(id, opts));

automation
  .command("delete")
  .description("Delete an automation")
  .argument("<id>", "Automation ID")
  .action((id) => handleAutomationDelete(id));

automation
  .command("test")
  .description("Preview/test an automation")
  .argument("<id>", "Automation ID")
  .action((id) => handleAutomationTest(id));

// ── Memory subcommand ──────────────────────────────────────────────────────

const memory = program
  .command("memory", { hidden: true })
  .description("Manage memory files");

memory
  .command("list")
  .description("List memory files")
  .option("--scope <scope>", "Scope: project, org, or user")
  .action((opts) => handleMemoryList(opts));

memory
  .command("read")
  .description("Read a memory file")
  .argument("<file-id>", "Memory file ID")
  .action((fileId) => handleMemoryRead(fileId));

memory
  .command("write")
  .description("Create or update a memory file")
  .requiredOption("--title <title>", "File title")
  .requiredOption("--content <content>", "File content")
  .option("--scope <scope>", "Scope: project, org, or user")
  .action((opts) => handleMemoryWrite(opts));

memory
  .command("delete")
  .description("Delete a memory file")
  .argument("<file-id>", "Memory file ID")
  .action((fileId) => handleMemoryDelete(fileId));

// ── Analysis commands ──────────────────────────────────────────────────────

program
  .command("search-analysis", { hidden: true })
  .description("Search codebase analysis results across one or all repos")
  .argument("<query>", "Search query")
  .option("--status <status>", "Filter by status (complete, running, failed)")
  .option("--prompt-key <key>", "Exact analysis type to filter by")
  .option("--limit <n>", "Max results total across matched repos (default 20)")
  .option(
    "--repo-id <id>",
    "Limit search to one repository. Omit to search every repo in the org.",
  )
  .action((query, opts) => handleSearchAnalysis(query, opts));

program
  .command("run-analysis", { hidden: true })
  .description("Run deep codebase analysis workflows on a repository")
  .option(
    "--prompts <list>",
    "Comma-separated: security,architecture,code-quality,performance,ux,dependencies,cost,ai-architecture,ai-security",
  )
  .option(
    "--repo-id <id>",
    "Target repository ID. Omit for single-repo orgs (auto-pick).",
  )
  .action((opts) => handleRunAnalysis(opts));

program
  .command("run-team-analysis", { hidden: true })
  .description("Run a team-wide AI coding practice analysis for the org")
  .option(
    "--window-days <n>",
    "Size of the analysis window in days (default 30, min 1, max 90)",
  )
  .action((opts) => handleRunTeamAnalysis(opts));

// ── Integration commands ───────────────────────────────────────────────────

program
  .command("integrations", { hidden: true })
  .description("List connected integrations")
  .action(() => handleIntegrations());

program
  .command("events", { hidden: true })
  .description("Recent integration events (deploys, releases, errors)")
  .option(
    "--source <source>",
    "Filter: github, sentry, linear, amplitude, stripe",
  )
  .option("--event-type <type>", "Filter by event type")
  .option("--project-id <id>", "Filter by project")
  .option("--since <duration>", "Time range: 1h, 6h, 24h, 7d, 30d")
  .action((opts) => handleEvents(opts));

program
  .command("resolve-identity", { hidden: true })
  .description("Resolve external identity to FML user")
  .argument("[username]", "External username (shorthand for --username)")
  .option("--provider <p>", "Provider: github, linear, slack")
  .option("--username <u>", "External username")
  .option("--email <e>", "Email address")
  .option("--external-id <id>", "External ID")
  .option("--external-user-id <id>", "External user ID")
  .action((username, opts) =>
    handleResolveIdentity(username ? { ...opts, username } : opts),
  );

// ── Slack subcommand ───────────────────────────────────────────────────────

const slack = program
  .command("slack", { hidden: true })
  .description("Slack shortcuts");

slack
  .command("history")
  .description("Recent messages from a channel")
  .option("--channel <id>", "Channel ID")
  .option("--limit <n>", "Max messages")
  .action((opts) => handleSlackHistory(opts));

slack
  .command("message")
  .description("Fetch a specific message")
  .option("--permalink <url>", "Message permalink")
  .option("--channel <id>", "Channel ID")
  .option("--ts <timestamp>", "Message timestamp")
  .option("--include-thread", "Include thread context")
  .action((opts) => handleSlackMessage(opts));

// ── Messages subcommand ────────────────────────────────────────────────────

const messages = program
  .command("messages", { hidden: true })
  .description("Conversation messages");

messages
  .command("list")
  .description("List messages from a conversation")
  .option("--start <timestamp>", "Start time (ms epoch)")
  .option("--end <timestamp>", "End time (ms epoch)")
  .option("--limit <n>", "Max messages")
  .option("--cursor <cursor>", "Pagination cursor")
  .action((opts) => handleMessagesList(opts));

messages
  .command("context")
  .description("Get messages around a specific message")
  .argument("<message-id>", "Message ID")
  .option("--before <n>", "Messages before")
  .option("--after <n>", "Messages after")
  .action((messageId, opts) => handleMessagesContext(messageId, opts));

// ── Skills subcommand ──────────────────────────────────────────────────────

const skills = program
  .command("skills", { hidden: true })
  .description("Browse and load skills");

skills
  .command("list")
  .description("List available skills")
  .action(() => handleSkillsList());

skills
  .command("load")
  .description("Load a skill by ID")
  .argument("<skill-id>", "Skill ID")
  .action((skillId) => handleSkillsLoad(skillId));

// ── Config subcommand ──────────────────────────────────────────────────────

const config = program
  .command("config", { hidden: true })
  .description("View team config snapshots");

config
  .command("list")
  .description("List config snapshots for an org")
  .requiredOption("--org <slug>", "Organization slug")
  .option("--repo <full-name>", "Filter by repo (owner/name)")
  .action((opts) => handleConfigList(opts));

config
  .command("detail")
  .description("Get config snapshot detail")
  .requiredOption("--org <slug>", "Organization slug")
  .option("--user <username>", "GitHub username")
  .option("--repo <full-name>", "Repository (owner/name)")
  .action((opts) => handleConfigDetail(opts));

// ────────────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  Sentry.captureException(err);
  console.error(err);
  process.exit(1);
});
