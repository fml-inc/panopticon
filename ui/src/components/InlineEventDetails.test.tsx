import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockFetch } from "@/test/mocks/api";
import { renderWithProviders } from "@/test/test-utils";
import { InlineEventDetails } from "./InlineEventDetails";

describe("InlineEventDetails", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("shows loading state initially", () => {
    renderWithProviders(<InlineEventDetails source="hook" eventId={2} />);

    expect(screen.getByText("Loading payload...")).toBeInTheDocument();
  });

  it("renders tool name when present", async () => {
    renderWithProviders(<InlineEventDetails source="hook" eventId={2} />);

    await waitFor(() => {
      expect(screen.getByText("Read")).toBeInTheDocument();
    });
  });

  it("renders payload tabs", async () => {
    renderWithProviders(<InlineEventDetails source="hook" eventId={2} />);

    await waitFor(() => {
      expect(screen.getByText("Raw")).toBeInTheDocument();
    });
  });

  it("renders Input tab for tool_input", async () => {
    renderWithProviders(<InlineEventDetails source="hook" eventId={2} />);

    await waitFor(() => {
      expect(screen.getByText("Input")).toBeInTheDocument();
    });
  });

  it("renders Result tab for tool_result", async () => {
    renderWithProviders(<InlineEventDetails source="hook" eventId={2} />);

    await waitFor(() => {
      expect(screen.getByText("Result")).toBeInTheDocument();
    });
  });

  it("fetches event from correct API endpoint", async () => {
    renderWithProviders(<InlineEventDetails source="hook" eventId={2} />);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/v2/events/hook/2"),
      );
    });
  });
});
