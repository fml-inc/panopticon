import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockFetch } from "@/test/mocks/api";
import { TimelinePanel } from "./TimelinePanel";

// TimelinePanel reads sessionId from useParams — needs a Route with path params
function renderTimeline(sessionId = "test-session-1", filter = "") {
  const route = `/sessions/${sessionId}${filter ? `?filter=${encodeURIComponent(filter)}` : ""}`;
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <NuqsTestingAdapter searchParams={filter ? { filter } : undefined}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/sessions/:sessionId" element={<TimelinePanel />} />
          </Routes>
        </MemoryRouter>
      </NuqsTestingAdapter>
    </QueryClientProvider>,
  );
}

function renderNoSession() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <NuqsTestingAdapter>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<TimelinePanel />} />
          </Routes>
        </MemoryRouter>
      </NuqsTestingAdapter>
    </QueryClientProvider>,
  );
}

describe("TimelinePanel", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns null when no sessionId", () => {
    const { container } = renderNoSession();
    expect(container.innerHTML).toBe("");
  });

  it("shows loading state", () => {
    renderTimeline();
    expect(screen.getByText("Loading timeline...")).toBeInTheDocument();
  });

  it("renders timeline header with session ID prefix", async () => {
    renderTimeline();

    await waitFor(() => {
      expect(screen.getByText("test-ses")).toBeInTheDocument();
    });
  });

  it("loads event data (shown by event count in header)", async () => {
    renderTimeline();

    // The virtualizer won't render items in jsdom (zero-height container),
    // but we can verify data loaded by checking the event count in the header.
    // The count appears in a span next to the h3 heading.
    await waitFor(() => {
      expect(screen.getByText("(3)")).toBeInTheDocument();
    });
  });

  it("renders Summarize button", async () => {
    renderTimeline();

    await waitFor(() => {
      expect(screen.getByText("Summarize")).toBeInTheDocument();
    });
  });

  it("renders filter input", () => {
    renderTimeline();
    expect(
      screen.getByPlaceholderText("Filter timeline..."),
    ).toBeInTheDocument();
  });

  it("fetches timeline from correct API endpoint", async () => {
    renderTimeline();

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/v2/sessions/test-session-1"),
      );
    });
  });
});
