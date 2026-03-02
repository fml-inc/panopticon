import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type RenderOptions, render } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
}

interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  route?: string;
  searchParams?: string | Record<string, string>;
}

export function renderWithProviders(
  ui: ReactElement,
  { route = "/", searchParams, ...options }: RenderWithProvidersOptions = {},
) {
  // Extract search params from route if not explicitly provided
  const sp =
    searchParams ?? (route.includes("?") ? route.split("?")[1] : undefined);

  const queryClient = createTestQueryClient();
  return render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <NuqsTestingAdapter searchParams={sp}>
          <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
        </NuqsTestingAdapter>
      </QueryClientProvider>
    ),
    ...options,
  });
}
