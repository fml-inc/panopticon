export const mockSessions = [
  {
    session_id: "test-session-1",
    start_ms: 1700000000000,
    end_ms: 1700003600000,
    event_count: 42,
    tool_count: 5,
    total_tokens: 150000,
    total_cost: 0.25,
  },
  {
    session_id: "test-session-2",
    start_ms: 1700010000000,
    end_ms: 1700012000000,
    event_count: 18,
    tool_count: 3,
    total_tokens: 50000,
    total_cost: 0.08,
  },
];

export const mockTimeline = {
  total: 3,
  rows: [
    {
      source: "hook",
      id: 1,
      session_id: "test-session-1",
      event_type: "SessionStart",
      timestamp_ms: 1700000000000,
      tool_name: null,
      cwd: "/home/user",
      payload: "{}",
      body: null,
      attributes: null,
      severity_text: null,
    },
    {
      source: "hook",
      id: 2,
      session_id: "test-session-1",
      event_type: "PostToolUse",
      timestamp_ms: 1700000001000,
      tool_name: "Read",
      cwd: "/home/user",
      payload: '{"tool_input":{"file_path":"/tmp/test.ts"}}',
      body: null,
      attributes: null,
      severity_text: null,
    },
    {
      source: "otel",
      id: 10,
      session_id: "test-session-1",
      event_type: "LLM call",
      timestamp_ms: 1700000002000,
      tool_name: null,
      cwd: null,
      payload: null,
      body: "LLM call",
      attributes: '{"model":"claude-sonnet-4-20250514"}',
      severity_text: "INFO",
    },
  ],
};

export const mockEvent = {
  source: "hook",
  id: 2,
  session_id: "test-session-1",
  event_type: "PostToolUse",
  timestamp_ms: 1700000001000,
  tool_name: "Read",
  cwd: "/home/user",
  payload: {
    tool_input: { file_path: "/tmp/test.ts" },
    tool_result: "file contents here",
  },
};

export const mockMetrics = {
  stats: [
    {
      tool_name: "Bash",
      call_count: 100,
      success_count: 90,
      failure_count: 10,
    },
    { tool_name: "Read", call_count: 80, success_count: 79, failure_count: 1 },
    { tool_name: "Edit", call_count: 50, success_count: 48, failure_count: 2 },
  ],
  costs: [
    {
      group_key: "2024-11-01",
      group_val: "2024-11-01",
      input_tokens: 50000,
      output_tokens: 20000,
      cache_read_tokens: 30000,
      cache_write_tokens: 5000,
      total_tokens: 70000,
      total_cost: 0.15,
    },
    {
      group_key: "2024-11-02",
      group_val: "2024-11-02",
      input_tokens: 80000,
      output_tokens: 30000,
      cache_read_tokens: 45000,
      cache_write_tokens: 8000,
      total_tokens: 110000,
      total_cost: 0.28,
    },
  ],
  modelCosts: [
    {
      group_key: "claude-sonnet-4-20250514",
      input_tokens: 100000,
      output_tokens: 40000,
      cache_read_tokens: 60000,
      cache_write_tokens: 10000,
      total_tokens: 140000,
      total_cost: 0.35,
    },
    {
      group_key: "claude-haiku-3.5",
      input_tokens: 30000,
      output_tokens: 10000,
      cache_read_tokens: 15000,
      cache_write_tokens: 3000,
      total_tokens: 40000,
      total_cost: 0.08,
    },
  ],
};

export const mockSearchResults = {
  total: 2,
  rows: [
    {
      source: "hook",
      id: 5,
      session_id: "test-session-1",
      event_type: "PostToolUse",
      timestamp_ms: 1700000005000,
      tool_name: "Bash",
      cwd: "/home/user",
      payload: '{"tool_input":{"command":"npm test"}}',
    },
    {
      source: "otel",
      id: 15,
      session_id: "test-session-2",
      event_type: "test log",
      timestamp_ms: 1700010005000,
      tool_name: null,
      cwd: null,
      payload: '{"body":"test log entry"}',
    },
  ],
};

export const mockWidgets = [
  {
    id: "widget-1",
    type: "kpi",
    title: "Total Sessions",
    query: "SELECT COUNT(DISTINCT session_id) as value FROM hook_events",
    config: '{"format":"number"}',
    position: 0,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
  {
    id: "widget-2",
    type: "chart",
    title: "Cost by Day",
    query:
      "SELECT date(timestamp_ns / 1000000000, 'unixepoch') as day, SUM(value) as cost FROM otel_metrics GROUP BY day",
    config: '{"chartType":"bar","xKey":"day","yKey":"cost"}',
    position: 1,
    created_at: 1700000000000,
    updated_at: 1700000000000,
  },
];

export const mockWidgetData = {
  columns: ["value"],
  rows: [{ value: 42 }],
};

export const mockDbStats = {
  otel_logs: 1500,
  otel_metrics: 3200,
  hook_events: 5000,
};
