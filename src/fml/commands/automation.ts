import { getAuthenticatedClient } from "../fml-client.js";

export async function handleAutomationList(): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("list-automations", {});
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleAutomationCreate(opts: {
  name: string;
  prompt: string;
  frequency: string;
  hour: string;
  minute: string;
  timezone: string;
  dayOfWeek?: string;
  dayOfMonth?: string;
  maxRuns?: string;
}): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("create-automation", {
    name: opts.name,
    prompt: opts.prompt,
    frequency: opts.frequency,
    hour: parseInt(opts.hour, 10),
    minute: parseInt(opts.minute, 10),
    timezone: opts.timezone,
    dayOfWeek: opts.dayOfWeek ? parseInt(opts.dayOfWeek, 10) : undefined,
    dayOfMonth: opts.dayOfMonth ? parseInt(opts.dayOfMonth, 10) : undefined,
    maxRuns: opts.maxRuns ? parseInt(opts.maxRuns, 10) : undefined,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleAutomationCreatePattern(opts: {
  name: string;
  prompt: string;
}): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("create-pattern-automation", {
    name: opts.name,
    prompt: opts.prompt,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleAutomationUpdate(
  id: string,
  opts: {
    name?: string;
    prompt?: string;
    enabled?: string;
    frequency?: string;
    hour?: string;
    minute?: string;
    timezone?: string;
    dayOfWeek?: string;
    dayOfMonth?: string;
  },
): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("update-automation", {
    automationId: id,
    name: opts.name,
    prompt: opts.prompt,
    enabled:
      opts.enabled !== undefined
        ? (() => {
            if (opts.enabled !== "true" && opts.enabled !== "false") {
              console.error(
                `Invalid --enabled value: "${opts.enabled}". Use "true" or "false".`,
              );
              process.exit(1);
            }
            return opts.enabled === "true";
          })()
        : undefined,
    frequency: opts.frequency,
    hour: opts.hour ? parseInt(opts.hour, 10) : undefined,
    minute: opts.minute ? parseInt(opts.minute, 10) : undefined,
    timezone: opts.timezone,
    dayOfWeek: opts.dayOfWeek ? parseInt(opts.dayOfWeek, 10) : undefined,
    dayOfMonth: opts.dayOfMonth ? parseInt(opts.dayOfMonth, 10) : undefined,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleAutomationDelete(id: string): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("delete-automation", {
    automationId: id,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}

export async function handleAutomationTest(id: string): Promise<void> {
  const api = await getAuthenticatedClient();
  if (!api) {
    console.error("Not authenticated. Run `fml login`.");
    process.exit(1);
  }
  const result = await api.callBackend("test-automation", {
    automationId: id,
  });
  if (!result.ok) {
    console.error(result.error || "Request failed");
    process.exit(1);
  }
  console.log(JSON.stringify(result.result, null, 2));
}
