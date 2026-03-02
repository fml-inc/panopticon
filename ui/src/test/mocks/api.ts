import { vi } from "vitest";
import {
  mockDbStats,
  mockEvent,
  mockMetrics,
  mockSearchResults,
  mockSessions,
  mockTimeline,
  mockWidgetData,
  mockWidgets,
} from "./fixtures";

type MockOverrides = {
  sessions?: any;
  timeline?: any;
  event?: any;
  metrics?: any;
  search?: any;
  widgets?: any;
  widgetData?: any;
  stats?: any;
};

export function mockFetch(overrides: MockOverrides = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.includes("/api/v2/widgets") && url.includes("/data")) {
      return Response.json(overrides.widgetData ?? mockWidgetData);
    }
    if (url.includes("/api/v2/widgets")) {
      return Response.json(overrides.widgets ?? mockWidgets);
    }
    if (url.includes("/api/v2/events/")) {
      return Response.json(overrides.event ?? mockEvent);
    }
    if (url.match(/\/api\/v2\/sessions\/[^/]+/)) {
      return Response.json(overrides.timeline ?? mockTimeline);
    }
    if (url.includes("/api/v2/sessions")) {
      return Response.json(overrides.sessions ?? mockSessions);
    }
    if (url.includes("/api/v2/metrics")) {
      return Response.json(overrides.metrics ?? mockMetrics);
    }
    if (url.includes("/api/v2/search")) {
      return Response.json(overrides.search ?? mockSearchResults);
    }
    if (url.includes("/api/v2/stats")) {
      return Response.json(overrides.stats ?? mockDbStats);
    }

    return Response.json({});
  });
}
