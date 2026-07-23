import { edcAssignmentPayloadSchema } from "@rtsm-core/schemas";
import Fastify, { type FastifyInstance } from "fastify";

/**
 * Minimal stand-in for edc-core's ADR-0010 intake, used by tests (and usable
 * as a local playground). Behavior mirrors the real contract as exercised by
 * edc-core's rtsm-intake.test.ts:
 *   - Bearer edcrtsm_* required → else 401
 *   - invalid payload → 400
 *   - subjectKey starting with "UNKNOWN" → 422 rejected (unknown subject)
 *   - same subject, same arm → 200 duplicate (idempotent replay)
 *   - same subject, different arm → 409 conflict (nothing written)
 *   - otherwise → 201 applied
 * Responses are { outcome, reason, eventId } and never echo the arm.
 */
export interface EdcStub {
  server: FastifyInstance;
  baseUrl: string;
  /** subjectKey → arm, per study path segment. */
  recorded: Map<string, string>;
  close: () => Promise<void>;
}

export async function startEdcStub(): Promise<EdcStub> {
  const server = Fastify({ logger: false });
  const recorded = new Map<string, string>();
  let eventCounter = 0;

  server.post("/studies/:edcStudyId/rtsm/assignments", async (request, reply) => {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer edcrtsm_")) {
      return reply.code(401).send({ error: "invalid api key" });
    }
    const parsed = edcAssignmentPayloadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid payload" });

    const { edcStudyId } = request.params as { edcStudyId: string };
    const key = `${edcStudyId}:${parsed.data.subjectKey}`;
    const eventId = `evt-${++eventCounter}`;

    if (parsed.data.subjectKey.startsWith("UNKNOWN")) {
      return reply.code(422).send({ outcome: "rejected", reason: "unknown subject", eventId });
    }
    const existing = recorded.get(key);
    if (existing !== undefined) {
      if (existing === parsed.data.arm) {
        return reply.code(200).send({ outcome: "duplicate", reason: null, eventId });
      }
      return reply
        .code(409)
        .send({ outcome: "conflict", reason: "a different value is present", eventId });
    }
    recorded.set(key, parsed.data.arm);
    return reply.code(201).send({ outcome: "applied", reason: null, eventId });
  });

  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  if (address === null || typeof address === "string") throw new Error("no listen address");
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    recorded,
    close: () => server.close(),
  };
}
