// QuickJS replacement for Playwright's packages/utils/zones.ts. Upstream tracks
// the current zone with node:async_hooks, which QuickJS lacks, so zones keep
// their data but are never "entered": currentZone() is always the empty zone.
// API calls are then attributed per call, as in earlier versions of this fork.

export type ZoneType = "apiZone" | "stepZone";

export class Zone {
  private readonly _data: ReadonlyMap<ZoneType, unknown>;

  constructor(data: Map<ZoneType, unknown> = new Map()) {
    this._data = data;
  }

  with(type: ZoneType, data: unknown): Zone {
    return new Zone(new Map(this._data).set(type, data));
  }

  without(type?: ZoneType): Zone {
    const data = type ? new Map(this._data) : new Map<ZoneType, unknown>();
    if (type) data.delete(type);
    return new Zone(data);
  }

  run<R>(func: () => R): R {
    return func();
  }

  data<T>(type: ZoneType): T | undefined {
    return this._data.get(type) as T | undefined;
  }
}

export const emptyZone = new Zone();

export function currentZone(): Zone {
  return emptyZone;
}
