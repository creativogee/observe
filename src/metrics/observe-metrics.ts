import { Injectable } from "@nestjs/common";
import { metrics } from "@opentelemetry/api";
import { admitsSeries, stringifyLabel } from "./series-limit.js";

type LabelRecord = Record<string, string>;

interface SeriesState {
  values: Record<string, unknown>;
  limit: { warned: boolean };
}

interface CounterHandle {
  add(value: number, labels?: LabelRecord): void;
}

interface HistogramHandle {
  record(value: number, labels?: LabelRecord): void;
}

@Injectable()
export class ObserveMetrics {
  private readonly meter = metrics.getMeter("@crudmates/observe");
  private readonly seriesByMetric = new Map<string, SeriesState>();

  counter(name: string, options?: { description?: string }): CounterHandle {
    const instrument = this.meter.createCounter(name, {
      description: options?.description,
    });
    const series = this.getSeriesState(name);

    return {
      add: (value: number, labels?: LabelRecord) => {
        const key = stringifyLabel(labels ?? {});
        if (!admitsSeries(name, series.values, key, series.limit)) {
          return;
        }
        series.values[key] = true;
        instrument.add(value, labels);
      },
    };
  }

  histogram(name: string, options?: { description?: string }): HistogramHandle {
    const instrument = this.meter.createHistogram(name, {
      description: options?.description,
    });
    const series = this.getSeriesState(name);

    return {
      record: (value: number, labels?: LabelRecord) => {
        const key = stringifyLabel(labels ?? {});
        if (!admitsSeries(name, series.values, key, series.limit)) {
          return;
        }
        series.values[key] = true;
        instrument.record(value, labels);
      },
    };
  }

  upDownCounter(
    name: string,
    options?: { description?: string },
  ): CounterHandle {
    const instrument = this.meter.createUpDownCounter(name, {
      description: options?.description,
    });
    const series = this.getSeriesState(name);

    return {
      add: (value: number, labels?: LabelRecord) => {
        const key = stringifyLabel(labels ?? {});
        if (!admitsSeries(name, series.values, key, series.limit)) {
          return;
        }
        series.values[key] = true;
        instrument.add(value, labels);
      },
    };
  }

  private getSeriesState(name: string): SeriesState {
    let state = this.seriesByMetric.get(name);
    if (!state) {
      state = { values: {}, limit: { warned: false } };
      this.seriesByMetric.set(name, state);
    }
    return state;
  }
}
