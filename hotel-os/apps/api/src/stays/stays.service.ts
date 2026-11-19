import { ConflictException, Inject, Injectable, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { type Db, schema, type TenantContext, withTenant } from "@hotel-os/db";
import type { CleanupReport, Language } from "@hotel-os/protocol";
import { and, desc, eq, inArray } from "drizzle-orm";
import { AuditService } from "../common/audit.service";
import { DB } from "../common/db.module";
import { CommandsService } from "../commands/commands.service";
import type { DevicePrincipal } from "../devices/device-auth.service";
import { PolicyService } from "../policy/policy.service";

const SYSTEM: TenantContext = { orgIds: [], platform: true };
const CLEANUP_TTL_SEC = 7 * 86400;

@Injectable()
export class StaysService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly commands: CommandsService,
    private readonly policy: PolicyService,
  ) {}

  onModuleInit() {
    // A cleanup command that expires or fails without a report marks the job FAILED.
    this.commands.onTerminal("CHECKOUT_CLEANUP", async (c) => {
      if (c.status === "SUCCEEDED") return;
      await withTenant(this.db, SYSTEM, (tx) =>
        tx
          .update(schema.cleanupJobs)
          .set({ status: "FAILED", finishedAt: new Date(), report: { reason: `command ${c.status}`, message: c.resultMessage } })
          .where(and(eq(schema.cleanupJobs.commandId, c.id), inArray(schema.cleanupJobs.status, ["PENDING", "RUNNING"]))),
      );
    });
  }

  async checkIn(ctx: TenantContext, room: { id: string; orgId: string; hotelId: string }, b: { guestFirstName?: string; displayNameConsent: boolean; language?: Language; pmsRef?: string }, userId: string) {
    const stay = await withTenant(this.db, ctx, async (tx) => {
      const [active] = await tx.select().from(schema.stays).where(and(eq(schema.stays.roomId, room.id), eq(schema.stays.status, "ACTIVE")));
      if (active) throw new ConflictException({ code: "ROOM_ALREADY_OCCUPIED", stayId: active.id });
      const [s] = await tx
        .insert(schema.stays)
        .values({
          organizationId: room.orgId,
          hotelId: room.hotelId,
          roomId: room.id,
          guestFirstName: b.displayNameConsent ? b.guestFirstName : null,
          displayNameConsent: b.displayNameConsent,
          language: b.language,
          pmsRef: b.pmsRef,
        })
        .returning();
      await this.audit.log(tx, { organizationId: room.orgId, actorType: "USER", actorId: userId, action: "stay.check_in", targetType: "ROOM", targetId: room.id, data: { stayId: s.id, language: b.language } });
      return s;
    });
    await this.policy.refreshScope({ scopeType: "ROOM", scopeId: room.id });
    return stay;
  }

  /**
   * Check-out: closes the stay, recomputes the room policy (guest data removed) and queues one
   * CHECKOUT_CLEANUP per device. The list of apps to clean comes from the device's effective policy.
   */
  async checkOut(ctx: TenantContext, room: { id: string; orgId: string }, userId: string) {
    const { stay, jobs } = await withTenant(this.db, ctx, async (tx) => {
      const [stay] = await tx.select().from(schema.stays).where(and(eq(schema.stays.roomId, room.id), eq(schema.stays.status, "ACTIVE")));
      if (!stay) throw new NotFoundException({ code: "NO_ACTIVE_STAY" });
      await tx.update(schema.stays).set({ status: "CHECKED_OUT", checkOutAt: new Date() }).where(eq(schema.stays.id, stay.id));
      const devices = await tx
        .select({ id: schema.devices.id })
        .from(schema.devices)
        .where(and(eq(schema.devices.roomId, room.id), inArray(schema.devices.status, ["ENROLLED", "ACTIVE"])));
      const jobs: { jobId: string; deviceId: string }[] = [];
      for (const d of devices) {
        const [job] = await tx.insert(schema.cleanupJobs).values({ organizationId: room.orgId, stayId: stay.id, deviceId: d.id }).returning();
        jobs.push({ jobId: job.id, deviceId: d.id });
      }
      await this.audit.log(tx, { organizationId: room.orgId, actorType: "USER", actorId: userId, action: "stay.check_out", targetType: "ROOM", targetId: room.id, data: { stayId: stay.id, cleanupJobs: jobs.length } });
      return { stay, jobs };
    });
    await this.policy.refreshScope({ scopeType: "ROOM", scopeId: room.id });
    for (const j of jobs) {
      const latest = await this.policy.latestDecoded(SYSTEM, j.deviceId);
      const apps = (latest?.policy.apps ?? []).filter((a) => a.cleanup !== "KEEP").map((a) => ({ packageName: a.packageName, action: a.cleanup }));
      const cmd = await this.commands.create(SYSTEM, {
        orgId: room.orgId,
        deviceId: j.deviceId,
        type: "CHECKOUT_CLEANUP",
        payload: { cleanupJobId: j.jobId, apps },
        idempotencyKey: `cleanup:${j.jobId}`,
        ttlSec: CLEANUP_TTL_SEC,
        createdBy: userId,
      });
      await withTenant(this.db, SYSTEM, (tx) => tx.update(schema.cleanupJobs).set({ commandId: cmd.id }).where(eq(schema.cleanupJobs.id, j.jobId)));
    }
    return { stayId: stay.id, cleanupJobs: jobs.map((j) => j.jobId) };
  }

  /** Report from the DPC. Also closes the CHECKOUT_CLEANUP command. */
  async report(dev: DevicePrincipal, jobId: string, r: CleanupReport) {
    const job = await withTenant(this.db, { orgIds: [dev.orgId] }, async (tx) => {
      const [job] = await tx.select().from(schema.cleanupJobs).where(eq(schema.cleanupJobs.id, jobId));
      if (!job || job.deviceId !== dev.deviceId) throw new NotFoundException({ code: "CLEANUP_JOB_NOT_FOUND" });
      await tx.update(schema.cleanupJobs).set({ status: r.outcome, report: r, finishedAt: new Date(r.finishedAt) }).where(eq(schema.cleanupJobs.id, jobId));
      await this.audit.log(tx, { organizationId: dev.orgId, actorType: "DEVICE", actorId: dev.deviceId, action: "cleanup.report", targetType: "CLEANUP_JOB", targetId: jobId, data: { outcome: r.outcome } });
      return job;
    });
    if (job.commandId) {
      await this.commands.transition(dev.deviceId, job.commandId, { status: r.outcome === "FAILED" ? "FAILED" : "SUCCEEDED", message: `cleanup ${r.outcome}` }, "device");
    }
    return { ok: true };
  }

  async listForRoom(ctx: TenantContext, roomId: string) {
    return withTenant(this.db, ctx, async (tx) => {
      const stays = await tx.select().from(schema.stays).where(eq(schema.stays.roomId, roomId)).orderBy(desc(schema.stays.checkInAt)).limit(20);
      const jobs = stays.length ? await tx.select().from(schema.cleanupJobs).where(inArray(schema.cleanupJobs.stayId, stays.map((s) => s.id))) : [];
      return stays.map((s) => ({ ...s, cleanupJobs: jobs.filter((j) => j.stayId === s.id) }));
    });
  }
}
