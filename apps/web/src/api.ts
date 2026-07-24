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
  status: "available" | "dispensed" | "damaged" | "quarantined";
  statusReason: string | null;
  siteCode: string | null;
  // Present only on the unblinded listing.
  kitTypeCode?: string;
  arm?: string;
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

export interface RandomizeResult {
  assignmentId: string;
  randomizationId: string;
  subjectKey: string;
  delivery: { outcome: string; httpStatus: number | null; reason: string | null };
}
