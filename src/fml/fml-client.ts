import { resolveRepoFromCwd } from "../repo.js";
import { getSelectedOrg, getValidToken } from "./auth/token-store.js";
import { CONVEX_URL } from "./config.js";
import type {
  RepoConfigSnapshotDetail,
  RepoConfigSnapshotSummary,
  ResolvedRepo,
  UserConfigSnapshotDetail,
  UserConfigSnapshotSummary,
} from "./types.js";

// ── Shared plumbing ─────────────────────────────────────────────────────────

export type ToolCategory =
  | "messages"
  | "slack"
  | "skills"
  | "analysis"
  | "integrations"
  | "engineering"
  | "memory"
  | "automations"
  | "amplitude"
  | "posthog"
  | "meta-ads";

export interface PublicToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  category?: ToolCategory;
  experimental?: boolean;
}

export type KnownToolErrorCode =
  | "UNAUTHENTICATED"
  | "TOKEN_EXPIRED"
  | "ACCESS_DENIED"
  | "ORG_REQUIRED"
  | "ORG_NOT_FOUND"
  | "REPO_NOT_FOUND"
  | "UNKNOWN_TOOL"
  | "INVALID_ARGS"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export type ToolErrorCode = KnownToolErrorCode | (string & {});

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: ToolErrorCode;
}

export interface OrgInfo {
  _id: string;
  name: string;
  slug?: string;
  repos?: Array<{
    _id: string;
    fullName: string;
    owner: string;
    name: string;
    private: boolean;
  }>;
}

const LOGIN_EXPIRED_MESSAGE =
  "Authentication expired. Run `fml login` to sign in again, then restart Claude Code.";

function isAuthError(data: { error?: string; code?: string }): boolean {
  return (
    data.code === "UNAUTHENTICATED" ||
    data.code === "TOKEN_EXPIRED" ||
    data.error?.includes("Unauthorized") === true ||
    data.error?.includes("not authenticated") === true
  );
}

function normalizeToolResult(data: ToolResult): ToolResult {
  if (!data.ok && isAuthError(data)) {
    return { ok: false, error: LOGIN_EXPIRED_MESSAGE, code: data.code };
  }
  return data;
}

function requireToolResult<T>(result: ToolResult): T {
  if (!result.ok) {
    throw new Error(result.error ?? "Backend request failed");
  }
  return result.result as T;
}

// ── API client factory ──────────────────────────────────────────────────────

export function createFmlClient(token: string) {
  const isServiceToken = token.startsWith("fml_st_");

  /**
   * Derive the Convex site URL (HTTP actions) from the cloud URL.
   * Convex uses paired domains: *.convex.cloud for client APIs,
   * *.convex.site for HTTP actions. This is a stable Convex convention.
   */
  function getSiteUrl(): string {
    return CONVEX_URL.replace(".convex.cloud", ".convex.site").replace(
      /\/$/,
      "",
    );
  }

  /** Authed fetch to a fml-be HTTP action, parsing the JSON envelope. */
  async function fetchContext(
    pathAndQuery: string,
    init: RequestInit,
  ): Promise<ToolResult> {
    try {
      const res = await fetch(`${getSiteUrl()}${pathAndQuery}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
      });
      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        return {
          ok: false,
          error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
        };
      }
      if (!res.ok) {
        const envelope = data as { error?: string; code?: ToolErrorCode };
        return normalizeToolResult({
          ok: false,
          error: envelope.error ?? `HTTP ${res.status}`,
          code: envelope.code,
        });
      }
      return { ok: true, result: data };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    // ── Orgs ──────────────────────────────────────────────────────────────

    async queryOrgs(): Promise<OrgInfo[]> {
      const result = await this.callBackend("list-orgs", {});
      return requireToolResult<OrgInfo[] | null>(result) ?? [];
    },

    // ── Tool gateway ─────────────────────────────────────────────────────

    async callBackend(
      toolName: string,
      args: Record<string, unknown>,
      opts?: { org?: string },
    ): Promise<ToolResult> {
      try {
        // Unified CLI/MCP path: POST to the dual-auth HTTP endpoint for both
        // service tokens and OAuth/JWT user tokens. This keeps command handlers
        // independent of token class and matches the backend's agent tool contract.
        const body: Record<string, unknown> = { toolName, args };

        // Explicit org > stored org selection > repo-based inference.
        const org = opts?.org ?? getSelectedOrg();
        if (org) body.org = org;
        const repo = resolveRepoFromCwd(process.cwd());
        if (repo) body.repo = repo.repo;

        // Thread user identity for service-token-backed sandbox agents. For
        // JWT callers this is ignored by the backend; for service tokens the
        // backend validates membership before honoring the override.
        if (isServiceToken) {
          const { readTokens, SERVICE_TOKEN_LOGIN_USER_ID } = await import(
            "./auth/token-store.js"
          );
          const stored = readTokens();
          const storedUserExternalId =
            stored?.tokenType === "service" &&
            stored.user.id !== SERVICE_TOKEN_LOGIN_USER_ID
              ? stored.user.id
              : undefined;
          const userExternalId =
            process.env.FML_USER_EXTERNAL_ID ?? storedUserExternalId;
          if (userExternalId) body.userExternalId = userExternalId;
        }

        const res = await fetch(`${getSiteUrl()}/api/tools/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(body),
        });
        const text = await res.text();
        let data: ToolResult;
        try {
          data = JSON.parse(text) as ToolResult;
        } catch {
          return {
            ok: false,
            error: `HTTP ${res.status}: ${text.slice(0, 200)}`,
          };
        }
        if (!res.ok && !data.error) {
          return { ok: false, error: `HTTP ${res.status}` };
        }
        return normalizeToolResult(data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Unauthorized") || msg.includes("not authenticated")) {
          return { ok: false, error: LOGIN_EXPIRED_MESSAGE };
        }
        return { ok: false, error: msg };
      }
    },

    // ── Tool catalog ─────────────────────────────────────────────────────

    async listTools(pluginVersion?: string): Promise<PublicToolDescriptor[]> {
      try {
        // Always use the HTTP catalog endpoint — it accepts both a service
        // token and a user OAuth JWT. A raw client.query rejects the user JWT
        // (no `aud` claim, which Convex's client-protocol auth requires), so
        // the httpAction path is the only one that works for both.
        const url = new URL(`${getSiteUrl()}/api/tools/list`);
        if (pluginVersion) url.searchParams.set("pluginVersion", pluginVersion);
        const res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${token}` },
        });
        const text = await res.text();
        let data: {
          ok: boolean;
          descriptors?: PublicToolDescriptor[];
          error?: string;
          code?: ToolErrorCode;
        };
        try {
          data = JSON.parse(text) as typeof data;
        } catch {
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        if (!data.ok || !data.descriptors) {
          if (isAuthError(data)) {
            throw new Error(LOGIN_EXPIRED_MESSAGE);
          }
          throw new Error(data.error ?? `HTTP ${res.status}`);
        }
        return data.descriptors;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Unauthorized") || msg.includes("not authenticated")) {
          throw new Error(LOGIN_EXPIRED_MESSAGE);
        }
        throw err;
      }
    },

    // ── Anamnesis ground-truth context ───────────────────────────────────

    /**
     * Call a read-only anamnesis context endpoint
     * (/v1/anamnesis/context/{path,commit,pr}). Sends the current token
     * (service token or user JWT) — the endpoint accepts either.
     */
    async anamnesisContext(
      kind: "path" | "commit" | "pr",
      params: Record<string, string | number | undefined>,
    ): Promise<ToolResult> {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v != null) qs.set(k, String(v));
      }
      return fetchContext(`/v1/anamnesis/context/${kind}?${qs.toString()}`, {
        method: "GET",
      });
    },

    /** POST /v1/anamnesis/context/query — generic predicate query. */
    async anamnesisQuery(body: Record<string, unknown>): Promise<ToolResult> {
      return fetchContext("/v1/anamnesis/context/query", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },

    // ── Repo resolution ──────────────────────────────────────────────────

    async resolveRepo(
      orgSlug: string,
      repoFullName: string,
    ): Promise<ResolvedRepo | null> {
      const result = await this.callBackend(
        "resolve-repo",
        { orgSlug, repoFullName },
        { org: orgSlug },
      );
      return requireToolResult<ResolvedRepo | null>(result);
    },

    // ── Config snapshots ─────────────────────────────────────────────────

    async listUserConfigSnapshots(
      orgSlug: string,
    ): Promise<UserConfigSnapshotSummary[]> {
      const result = await this.callBackend(
        "list-user-config-snapshots",
        { orgSlug },
        { org: orgSlug },
      );
      return (
        requireToolResult<UserConfigSnapshotSummary[] | null>(result) ?? []
      );
    },

    async getUserConfigDetail(
      orgSlug: string,
      githubUsername: string,
    ): Promise<UserConfigSnapshotDetail | null> {
      const result = await this.callBackend(
        "get-user-config-snapshot",
        { orgSlug, githubUsername },
        { org: orgSlug },
      );
      return requireToolResult<UserConfigSnapshotDetail | null>(result);
    },

    async listRepoConfigSnapshots(
      orgSlug: string,
      repository?: string,
    ): Promise<RepoConfigSnapshotSummary[]> {
      const result = await this.callBackend(
        "list-repo-config-snapshots",
        { orgSlug, repository },
        { org: orgSlug },
      );
      return (
        requireToolResult<RepoConfigSnapshotSummary[] | null>(result) ?? []
      );
    },

    async getRepoConfigDetail(
      orgSlug: string,
      repository: string,
    ): Promise<RepoConfigSnapshotDetail | null> {
      const result = await this.callBackend(
        "get-repo-config-snapshot",
        { orgSlug, repository },
        { org: orgSlug },
      );
      return requireToolResult<RepoConfigSnapshotDetail | null>(result);
    },
  };
}

// ── Convenience: auto-authenticated client ──────────────────────────────────

/**
 * Create an API client using the stored auth token.
 * Returns null if not authenticated.
 */
export async function getAuthenticatedClient() {
  const token = await getValidToken();
  if (!token) return null;
  return createFmlClient(token);
}
