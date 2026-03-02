import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockFetch } from "@/test/mocks/api";
import { renderWithProviders } from "@/test/test-utils";
import { SearchResults } from "./SearchResults";

describe("SearchResults", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows empty state when no query", () => {
    renderWithProviders(<SearchResults />, { route: "/search" });

    expect(screen.getByText("Search Stream")).toBeInTheDocument();
  });

  it("renders search results for a query", async () => {
    renderWithProviders(<SearchResults />, { route: "/search?q=test" });

    await waitFor(() => {
      expect(screen.getByText("Hook")).toBeInTheDocument();
    });

    expect(screen.getByText("OTel")).toBeInTheDocument();
  });

  it("shows tool name badge when present", async () => {
    renderWithProviders(<SearchResults />, { route: "/search?q=test" });

    await waitFor(() => {
      expect(screen.getByText("Bash")).toBeInTheDocument();
    });
  });

  it("displays event type", async () => {
    renderWithProviders(<SearchResults />, { route: "/search?q=test" });

    await waitFor(() => {
      expect(screen.getByText("PostToolUse")).toBeInTheDocument();
    });
  });

  it("fetches from search API with query", async () => {
    renderWithProviders(<SearchResults />, { route: "/search?q=test" });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/v2/search?q=test"),
      );
    });
  });
});
