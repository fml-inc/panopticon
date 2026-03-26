import type { OtelMetricRow } from "../db/store.js";
import {
  attrsToMap,
  ExportMetricsServiceRequest,
  longToNumber,
} from "./proto.js";

export function decodeMetrics(buf: Uint8Array): OtelMetricRow[] {
  const message = ExportMetricsServiceRequest.decode(buf) as any;
  const rows: OtelMetricRow[] = [];

  for (const resourceMetric of message.resourceMetrics ?? []) {
    const resourceAttrs = attrsToMap(resourceMetric.resource?.attributes);
    const resourceSessionId =
      (resourceAttrs["session.id"] as string) ??
      (resourceAttrs["conversation.id"] as string) ??
      (resourceAttrs["service.instance.id"] as string) ??
      undefined;

    for (const scopeMetric of resourceMetric.scopeMetrics ?? []) {
      for (const metric of scopeMetric.metrics ?? []) {
        const name = metric.name;
        const unit = metric.unit || undefined;

        // Determine metric type and extract data points
        let metricType: string | undefined;
        let dataPoints: any[] = [];

        if (metric.gauge) {
          metricType = "gauge";
          dataPoints = metric.gauge.dataPoints ?? [];
        } else if (metric.sum) {
          metricType = "sum";
          dataPoints = metric.sum.dataPoints ?? [];
        } else if (metric.histogram) {
          metricType = "histogram";
          // For histograms, use sum as value
          for (const dp of metric.histogram.dataPoints ?? []) {
            const attrs = attrsToMap(dp.attributes);
            rows.push({
              timestamp_ns: longToNumber(dp.timeUnixNano),
              name,
              value: dp.sum ?? 0,
              metric_type: "histogram",
              unit,
              attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
              resource_attributes:
                Object.keys(resourceAttrs).length > 0
                  ? resourceAttrs
                  : undefined,
              session_id:
                (attrs["session.id"] as string) ??
                (attrs["conversation.id"] as string) ??
                resourceSessionId,
            });
          }
          continue;
        }

        // NumberDataPoint (gauge and sum)
        for (const dp of dataPoints) {
          const attrs = attrsToMap(dp.attributes);
          const value =
            dp.asDouble != null
              ? dp.asDouble
              : dp.asInt != null
                ? longToNumber(dp.asInt)
                : 0;

          rows.push({
            timestamp_ns: longToNumber(dp.timeUnixNano),
            name,
            value,
            metric_type: metricType,
            unit,
            attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
            resource_attributes:
              Object.keys(resourceAttrs).length > 0 ? resourceAttrs : undefined,
            session_id: (attrs["session.id"] as string) ?? resourceSessionId,
          });
        }
      }
    }
  }

  return rows;
}
