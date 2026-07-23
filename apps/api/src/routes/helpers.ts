import { DomainError } from "@rtsm-core/core";
import { type Db, studies } from "@rtsm-core/db";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isStudyMember } from "../auth/rbac.js";

export function studyIdOf(request: FastifyRequest): string {
  return (request.params as { studyId: string }).studyId;
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

export async function replyDomainError(reply: FastifyReply, err: unknown): Promise<boolean> {
  if (err instanceof DomainError) {
    await reply.code(err.statusCode).send({ error: err.message });
    return true;
  }
  return false;
}
