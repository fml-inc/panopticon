import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockFetch } from "@/test/mocks/api";
import { renderWithProviders } from "@/test/test-utils";
import { AI } from "./AI";

describe("AI", () => {
  let fetchSpy: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    fetchSpy = mockFetch();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders header and input area", () => {
    renderWithProviders(<AI />);

    expect(screen.getByText("AI Assistant")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(/Ask about your sessions/i),
    ).toBeInTheDocument();
  });

  it("shows suggestion buttons on empty state", () => {
    renderWithProviders(<AI />);

    expect(
      screen.getByText("Summarize my most recent session"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Which tools have the highest failure rate?"),
    ).toBeInTheDocument();
  });

  it("has a send button", () => {
    renderWithProviders(<AI />);

    const sendBtn = document.querySelector("[data-send-btn]");
    expect(sendBtn).toBeInTheDocument();
  });

  it("renders start conversation empty state", () => {
    renderWithProviders(<AI />);

    expect(screen.getByText("Start a conversation")).toBeInTheDocument();
  });
});
