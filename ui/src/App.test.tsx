import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import App from "./App";

const queryClient = new QueryClient();

describe("App Layout", () => {
  it("renders the sidebar navigation", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Check if the logo/title exists
    expect(screen.getByText("PANOPTICON")).toBeInTheDocument();

    // Check if navigation links exist
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Metrics")).toBeInTheDocument();

    // Check if search input exists
    expect(screen.getByPlaceholderText(/Search all/i)).toBeInTheDocument();
  });
});
