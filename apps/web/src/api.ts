export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    headers: init?.body ? { "content-type": "application/json" } : {},
    ...init,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export interface Me {
  id: string;
  username: string;
  fullName: string;
  isSystemAdmin: boolean;
  hasPassword: boolean;
}

// edcApiKey never appears in API responses (ADR-0004).
export interface Study {
  id: string;
  name: string;
  edcBaseUrl: string;
  edcStudyId: string;
  enabled: boolean;
}

export interface RandomizationList {
  id: string;
  version: number;
  status: "draft" | "active" | "retired";
  filename: string;
  sha256: string;
  rowCount: number;
  createdAt: string;
  activatedAt: string | null;
  activationReason: string | null;
}

export interface Site {
  id: string;
  code: string;
  name: string;
  status: "active" | "closed";
  createdAt: string;
}

// arm appears only in unblinded serializations (kit.read_unblinded).
export interface KitTypeRow {
  id: string;
  code: string;
  arm: string;
  description: string;
}

export interface KitRow {
  id: string;
  kitNumber: string;
  lot: string;
  expiresOn: string;
  status: "available" | "dispensed" | "damaged" | "quarantined" | "in_transit" | "lost";
  statusReason: string | null;
  siteCode: string | null;
  depotCode: string | null;
  // Present only on the unblinded listing.
  kitTypeCode?: string;
  arm?: string;
}

export interface Depot {
  id: string;
  code: string;
  name: string;
  status: "active" | "closed";
}

export interface ShipmentRow {
  id: string;
  depotCode: string;
  siteCode: string;
  status: "in_transit" | "received";
  kitCount: number;
  createdAt: string;
  receivedAt: string | null;
}

// Blinded manifest: no kit-type identifier anywhere.
export interface ShipmentManifest {
  id: string;
  depotCode: string;
  siteCode: string;
  status: "in_transit" | "received";
  minShelfLifeDays: number;
  createdAt: string;
  receivedAt: string | null;
  kits: Array<{
    kitNumber: string;
    lot: string;
    expiresOn: string;
    disposition: "received" | "damaged" | "missing" | null;
    dispositionReason: string | null;
  }>;
}

// kit.manage-only surface: names kit types by design.
export interface ResupplyRequestRow {
  id: string;
  siteCode: string;
  kitTypeCode: string;
  quantity: number;
  status: "open" | "fulfilled" | "dismissed";
  shipmentId: string | null;
  createdAt: string;
}

export interface AssignmentRow {
  id: string;
  subjectKey: string;
  randomizationId: string;
  siteCode: string | null;
  createdAt: string;
  lastDelivery: { outcome: string; createdAt: string } | null;
}

export interface DeliveryRow {
  id: string;
  assignmentId: string;
  outcome: string;
  httpStatus: number | null;
  reason: string | null;
  payload: { subjectKey: string; arm: string; randomizationId: string };
  createdAt: string;
}

export interface DispenseResult {
  subjectKey: string;
  dispenseEventId: string;
  kitNumber: string;
  lot: string;
  expiresOn: string;
  dispensedAt: string;
}

export interface DispenseRow {
  id: string;
  subjectKey: string;
  kitNumber: string;
  siteCode: string;
  createdAt: string;
}

// The arm appears exactly once, in the code-break response (ADR-0007).
export interface CodeBreakResult {
  codeBreakId: string;
  subjectKey: string;
  arm: string;
  createdAt: string;
}

export interface CodeBreakRow {
  id: string;
  subjectKey: string;
  reason: string;
  performedBy: string;
  createdAt: string;
}

export interface RandomizeResult {
  assignmentId: string;
  randomizationId: string;
  subjectKey: string;
  delivery: { outcome: string; httpStatus: number | null; reason: string | null };
}
