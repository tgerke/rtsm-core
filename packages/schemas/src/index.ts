import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  version: z.string(),
  time: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const loginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

// ---------------------------------------------------------------------------
// Studies (the EDC integration target)
// ---------------------------------------------------------------------------

export const studyCreateSchema = z.object({
  name: z.string().min(1).max(200),
  edcBaseUrl: z.url(),
  edcStudyId: z.string().min(1).max(200),
  // The edcrtsm_ intake key (ADR-0004). Accepted on create/update, never
  // serialized back out.
  edcApiKey: z.string().min(1).max(500),
});
export type StudyCreateRequest = z.infer<typeof studyCreateSchema>;

export const studyUpdateSchema = studyCreateSchema.partial().extend({
  enabled: z.boolean().optional(),
});
export type StudyUpdateRequest = z.infer<typeof studyUpdateSchema>;

// ---------------------------------------------------------------------------
// Randomization lists (ADR-0001)
// ---------------------------------------------------------------------------

export const listImportSchema = z.object({
  filename: z.string().min(1).max(300),
  csv: z.string().min(1).max(5_000_000),
});
export type ListImportRequest = z.infer<typeof listImportSchema>;

// Activation is the GxP-significant act: password step-up plus a reason,
// both captured (P11-06).
export const listActivateSchema = z.object({
  password: z.string().min(1),
  reason: z.string().min(1).max(1000),
});
export type ListActivateRequest = z.infer<typeof listActivateSchema>;

// ---------------------------------------------------------------------------
// Randomization
// ---------------------------------------------------------------------------

export const randomizeRequestSchema = z.object({
  // Exact-match allocation stratum ('' / absent = unstratified list).
  stratum: z.string().max(200).optional(),
  // Optional descriptive covariates forwarded opaquely to the EDC intake.
  strata: z.record(z.string(), z.string()).optional(),
});
export type RandomizeRequest = z.infer<typeof randomizeRequestSchema>;

// ---------------------------------------------------------------------------
// Outbound EDC intake payload. Mirrors edc-core's rtsmAssignmentSchema
// (apps/api/src/services/rtsm.ts) — the ADR-0010 wire contract.
// ---------------------------------------------------------------------------

export const edcAssignmentPayloadSchema = z.object({
  subjectKey: z.string().min(1).max(200),
  arm: z.string().min(1).max(500),
  randomizationId: z.string().min(1).max(200),
  assignedAt: z.iso.datetime({ offset: true }).optional(),
  strata: z.record(z.string(), z.string()).optional(),
  source: z.string().min(1).max(200).optional(),
});
export type EdcAssignmentPayload = z.infer<typeof edcAssignmentPayloadSchema>;

export const DELIVERY_OUTCOMES = ["applied", "duplicate", "conflict", "rejected", "error"] as const;
export const deliveryOutcomeSchema = z.enum(DELIVERY_OUTCOMES);
export type DeliveryOutcomeName = z.infer<typeof deliveryOutcomeSchema>;
