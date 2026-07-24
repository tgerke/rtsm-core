import { DomainError } from "@rtsm-core/core";
import { type Db, studies } from "@rtsm-core/db";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isStudyMember } from "../auth/rbac.js";

export function studyIdOf(request: FastifyRequest): string {
  return (request.params as { studyId: string }).studyId;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * siteId from a not-yet-validated request body, for permission scopes that
 * run before schema validation. Non-UUID values are dropped here (the guard
 * then applies the study-wide rule) and rejected later by the body schema.
 */
export function siteIdOfBody(request: FastifyRequest): { siteId: string } | Record<never, never> {
  const siteId = (request.body as { siteId?: unknown } | null)?.siteId;
  return typeof siteId === "string" && UUID_RE.test(siteId) ? { siteId } : {};
}

export async function loadStudy(db: Db, studyId: string) {
  const [study] = await db.select().from(studies).where(eq(studies.id, studyId)).limit(1);
  if (!study) throw new DomainError("study not found", 404);
  return study;
}

/** The intake key never leaves the server (ADR-0004). */
export function serializeStudy(study: typeof studies.$inferSelect) {
  const { edcApiKey: _edcApiKey, ...rest } = study;
  return rest;
}

/** Read visibility = study membership (any unrevoked grant) or system admin. */
export function requireMembership() {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      await reply.code(401).send({ error: "authentication required" });
      return;
    }
    if (request.user.isSystemAdmin) return;
    const member = await isStudyMember(request.server.db, request.user.id, studyIdOf(request));
    if (!member) {
      await reply.code(403).send({ error: "not a member of this study" });
    }
  };
}

/** Postgres 23505, possibly wrapped by the driver/ORM in `cause`. */
export function isUniqueViolation(err: unknown): boolean {
  for (let e = err; typeof e === "object" && e !== null; e = (e as Error).cause) {
    if ((e as { code?: string }).code === "23505") return true;
  }
  return false;
}

export async function replyDomainError(reply: FastifyReply, err: unknown): Promise<boolean> {
  if (err instanceof DomainError) {
    await reply.code(err.statusCode).send({ error: err.message });
    return true;
  }
  return false;
}
