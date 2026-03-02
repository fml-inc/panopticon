import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "@/test/test-utils";
import type { Widget, WidgetData } from "@/types/widget";
import { WidgetRenderer } from "./WidgetRenderer";

const kpiWidget: Widget = {
  id: "w1",
  type: "kpi",
  title: "Total Sessions",
  query: "SELECT COUNT(*) as value FROM hook_events",
  config: { valueKey: "value", format: "number" },
  position: 0,
  created_at: 0,
  updated_at: 0,
};

const tableWidget: Widget = {
  id: "w2",
  type: "table",
  title: "Recent Events",
  query: "SELECT * FROM hook_events LIMIT 10",
  config: { pageSize: 10 },
  position: 1,
  created_at: 0,
  updated_at: 0,
};

const kpiData: WidgetData = {
  columns: ["value"],
  rows: [{ value: 42 }],
};

const tableData: WidgetData = {
  columns: ["id", "event_type"],
  rows: [
    { id: 1, event_type: "ToolUseBegin" },
    { id: 2, event_type: "ToolUseEnd" },
  ],
};

describe("WidgetRenderer", () => {
  it("shows loading skeleton when loading", () => {
    const { container } = renderWithProviders(
      <WidgetRenderer
        widget={kpiWidget}
        data={undefined}
        isLoading={true}
        error={null}
      />,
    );

    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("shows error message", () => {
    renderWithProviders(
      <WidgetRenderer
        widget={kpiWidget}
        data={undefined}
        isLoading={false}
        error={new Error("Query failed")}
      />,
    );

    expect(screen.getByText("Error: Query failed")).toBeInTheDocument();
  });

  it("shows no data message", () => {
    renderWithProviders(
      <WidgetRenderer
        widget={kpiWidget}
        data={undefined}
        isLoading={false}
        error={null}
      />,
    );

    expect(screen.getByText("No data")).toBeInTheDocument();
  });

  it("renders KPI widget with value", () => {
    renderWithProviders(
      <WidgetRenderer
        widget={kpiWidget}
        data={kpiData}
        isLoading={false}
        error={null}
      />,
    );

    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders table widget with rows", () => {
    renderWithProviders(
      <WidgetRenderer
        widget={tableWidget}
        data={tableData}
        isLoading={false}
        error={null}
      />,
    );

    expect(screen.getByText("ToolUseBegin")).toBeInTheDocument();
    expect(screen.getByText("ToolUseEnd")).toBeInTheDocument();
  });

  it("renders table widget column headers", () => {
    renderWithProviders(
      <WidgetRenderer
        widget={tableWidget}
        data={tableData}
        isLoading={false}
        error={null}
      />,
    );

    expect(screen.getByText("id")).toBeInTheDocument();
    expect(screen.getByText("event_type")).toBeInTheDocument();
  });

  it("shows unknown type for invalid widget type", () => {
    const badWidget = { ...kpiWidget, type: "invalid" as any };
    renderWithProviders(
      <WidgetRenderer
        widget={badWidget}
        data={kpiData}
        isLoading={false}
        error={null}
      />,
    );

    expect(
      screen.getByText("Unknown widget type: invalid"),
    ).toBeInTheDocument();
  });
});
