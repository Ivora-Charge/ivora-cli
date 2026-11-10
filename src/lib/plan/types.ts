export type PlanAction = 'create' | 'update' | 'delete' | 'no-op';

export interface Change {
  path: string;
  /** Live value; undefined when the field is not set live. */
  from?: unknown;
  /** Value in the file; undefined when the file leaves it unset. */
  to?: unknown;
}

export interface PlanEntry {
  section: 'locations' | 'tariffs' | 'stations' | 'webhooks';
  /** The local key (for a delete: the live identity). */
  key: string;
  action: PlanAction;
  /** The live id, when the resource exists live. */
  id?: string | number;
  changes: Change[];
  /** Risks (design 2.2) this entry carries. */
  risks: string[];
}

/** A proposal to link an existing live resource to a local key (design 1.4). Never applied here. */
export interface AdoptHint {
  section: PlanEntry['section'];
  key: string;
  id: string | number;
  reason: string;
  proposal: string;
}

export interface PowerGroup {
  group: string;
  limit_w?: number;
  connected_w: number;
  status: 'ok' | 'over' | 'unknown';
  note?: string;
}

export interface PowerImpact {
  available: boolean;
  /** Why not available, or what the numbers are based on. */
  note: string;
  groups: PowerGroup[];
}

export interface Plan {
  file: string;
  tenant: string;
  entries: PlanEntry[];
  adopt: AdoptHint[];
  /** Live resources with no counterpart in the file and no marker: left alone. */
  unmanaged: { section: PlanEntry['section']; id: string | number; identity: string }[];
  skipped: { section: string; reason: string }[];
  /** Things plan could not compare, or assumes. */
  notes: string[];
  power: PowerImpact;
  summary: Record<PlanAction, number>;
}

/** The live state read through the public /v1 API. */
export interface Live {
  locations: Rec[];
  tariffs: Rec[];
  stations: Rec[];
  webhooks: Rec[];
  /** Tax per live location id; undefined when the read failed or is unconfigured. */
  tax: Map<number, Rec | undefined>;
}

export type Rec = Record<string, unknown>;
