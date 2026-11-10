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
  /** Design 2.1 checks plan does not run yet. */
  not_checked: string[];
}

export interface Plan {
  file: string;
  tenant: string;
  entries: PlanEntry[];
  adopt: AdoptHint[];
  /** Live resources without an ivora.key and not matched by the file: reported, never deleted. */
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
  /** Tax per live location id (as a string); undefined when not configured. */
  tax: Map<string, Rec | undefined>;
  /** Location id -> why its tax could not be read (403 or 404). */
  taxSkipped: Map<string, string>;
  /** Stations with a session in progress, when the key can read transactions. */
  openSessions: { known: true; stations: Set<string> } | { known: false; reason: string };
}

export type Rec = Record<string, unknown>;
