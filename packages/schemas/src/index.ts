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
// Sites
// ---------------------------------------------------------------------------

export const siteCreateSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
});
export type SiteCreateRequest = z.infer<typeof siteCreateSchema>;

export const siteUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "closed"]).optional(),
});
export type SiteUpdateRequest = z.infer<typeof siteUpdateSchema>;

// ---------------------------------------------------------------------------
// Kit types and inventory
// ---------------------------------------------------------------------------

// arm is accepted here (the unblinded pharmacist defines the map) but is
// never serialized back outside the kit.read_unblinded path.
export const kitTypeCreateSchema = z.object({
  code: z.string().min(1).max(50),
  arm: z.string().min(1).max(500),
  description: z.string().max(500).optional(),
});
export type KitTypeCreateRequest = z.infer<typeof kitTypeCreateSchema>;

// Import lands at a depot (ADR-0009); depot-to-site is always a shipment.
export const kitImportSchema = z.object({
  csv: z.string().min(1).max(5_000_000),
  depotId: z.uuid(),
});
export type KitImportRequest = z.infer<typeof kitImportSchema>;

// Pharmacist inventory act: a status change with the reason captured for the
// audit trail. 'dispensed'/'in_transit'/'lost' are flow-owned, not settable;
// location changes go through shipments (ADR-0009).
export const kitUpdateSchema = z.object({
  status: z.enum(["available", "damaged", "quarantined"]),
  reason: z.string().min(1).max(1000),
});
export type KitUpdateRequest = z.infer<typeof kitUpdateSchema>;

// ---------------------------------------------------------------------------
// Depots, shipments, resupply (ADR-0009)
// ---------------------------------------------------------------------------

export const depotCreateSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
});
export type DepotCreateRequest = z.infer<typeof depotCreateSchema>;

export const depotUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  status: z.enum(["active", "closed"]).optional(),
});
export type DepotUpdateRequest = z.infer<typeof depotUpdateSchema>;

// Composition is by type and quantity; the server picks the kits (FEFO with
// the per-shipment shelf-life floor). Creating a shipment is the dispatch.
export const shipmentCreateSchema = z.object({
  depotId: z.uuid(),
  siteId: z.uuid(),
  minShelfLifeDays: z.number().int().min(0).max(3650).optional(),
  items: z
    .array(
      z.object({
        kitTypeCode: z.string().min(1).max(50),
        quantity: z.number().int().min(1).max(10_000),
      }),
    )
    .min(1),
});
export type ShipmentCreateRequest = z.infer<typeof shipmentCreateSchema>;

// The blinded receiving act: every kit on the shipment gets a disposition;
// damaged/missing require the reason.
export const shipmentReceiveSchema = z.object({
  dispositions: z
    .array(
      z.object({
        kitNumber: z.string().min(1).max(100),
        disposition: z.enum(["received", "damaged", "missing"]),
        reason: z.string().min(1).max(1000).optional(),
      }),
    )
    .min(1),
});
export type ShipmentReceiveRequest = z.infer<typeof shipmentReceiveSchema>;

// Fall to trigger, propose up to target (ADR-0009).
export const resupplySchemeSchema = z
  .object({
    siteId: z.uuid(),
    kitTypeCode: z.string().min(1).max(50),
    triggerLevel: z.number().int().min(0).max(100_000),
    targetLevel: z.number().int().min(1).max(100_000),
  })
  .refine((s) => s.targetLevel > s.triggerLevel, {
    message: "targetLevel must be greater than triggerLevel",
  });
export type ResupplySchemeRequest = z.infer<typeof resupplySchemeSchema>;

export const resupplyDismissSchema = z.object({
  reason: z.string().min(1).max(1000),
});
export type ResupplyDismissRequest = z.infer<typeof resupplyDismissSchema>;

// Do-not-dispense window (ADR-0009): kits expiring within the window are
// excluded from dispensing FEFO.
export const dispenseWindowSchema = z.object({
  doNotDispenseDays: z.number().int().min(0).max(3650),
});
export type DispenseWindowRequest = z.infer<typeof dispenseWindowSchema>;

// The dispensing site; the server resolves the subject's arm to a kit
// without revealing either.
export const dispenseRequestSchema = z.object({
  siteId: z.uuid(),
});
export type DispenseRequest = z.infer<typeof dispenseRequestSchema>;

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
  // Randomizing site; required by site-scoped grants, optional otherwise.
  siteId: z.uuid().optional(),
});
export type RandomizeRequest = z.infer<typeof randomizeRequestSchema>;

// ---------------------------------------------------------------------------
// Emergency code-break (ADR-0007)
// ---------------------------------------------------------------------------

// Same step-up shape as list activation: password plus a captured reason.
export const codeBreakRequestSchema = z.object({
  password: z.string().min(1),
  reason: z.string().min(1).max(1000),
});
export type CodeBreakRequest = z.infer<typeof codeBreakRequestSchema>;

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
