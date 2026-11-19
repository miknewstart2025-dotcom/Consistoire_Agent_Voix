import { Injectable } from "@nestjs/common";
import { type Db, schema } from "@hotel-os/db";

export interface AuditEntry {
  organizationId: string | null;
  actorType: "USER" | "DEVICE" | "SYSTEM";
  actorId: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  data?: Record<string, unknown>;
  ip?: string;
}

/** Append-only audit log. Must be written inside the same transaction as the change it records. */
@Injectable()
export class AuditService {
  async log(tx: Db, e: AuditEntry): Promise<void> {
    await tx.insert(schema.auditLogs).values({
      organizationId: e.organizationId,
      actorType: e.actorType,
      actorId: e.actorId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      data: e.data ?? {},
      ip: e.ip,
    });
  }
}
