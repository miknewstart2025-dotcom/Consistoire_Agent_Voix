import { Body, Controller, ForbiddenException, Get, Inject, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import { type Db, schema, withTenant } from "@hotel-os/db";
import { CommandType } from "@hotel-os/protocol";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { AccessService } from "../auth/access.service";
import { AdminGuard } from "../auth/admin.guard";
import { CurrentPrincipal, type Principal } from "../auth/principal";
import { BASIC_COMMANDS } from "../auth/rbac";
import { AuditService } from "../common/audit.service";
import { DB } from "../common/db.module";
import { parse, uuidParam } from "../common/validation";
import { CommandsService } from "./commands.service";

/** Payload schema per command type: unknown payload keys are rejected. */
const PAYLOADS: Partial<Record<CommandType, z.ZodTypeAny>> = {
  REBOOT_DEVICE: z.object({}).strict(),
  RESTART_LAUNCHER: z.object({}).strict(),
  REFRESH_UI: z.object({}).strict(),
  SYNC_NOW: z.object({}).strict(),
  UPLOAD_LOGS: z.object({ minutes: z.number().int().min(1).max(1440).default(60) }).strict(),
  RUN_DIAGNOSTICS: z.object({}).strict(),
  RUN_CERTIFICATION: z.object({}).strict(),
  LAUNCH_APP: z.object({ packageName: z.string().min(3).max(200) }).strict(),
  SHOW_MESSAGE: z
    .object({ text: z.string().min(1).max(500), title: z.string().max(80).optional(), durationSec: z.number().int().min(5).max(3600).default(30), priority: z.enum(["NORMAL", "HIGH"]).default("NORMAL") })
    .strict(),
};
/** Created only by the platform through dedicated flows (checkout, rollouts, maintenance, emergency). */
const NOT_DIRECT = new Set<CommandType>(["CHECKOUT_CLEANUP", "INSTALL_APP", "UNINSTALL_APP", "ENTER_MAINTENANCE", "EMERGENCY_BROADCAST"]);

const Body_ = z.object({ type: CommandType, payload: z.record(z.unknown()).default({}), idempotencyKey: z.string().max(100).optional(), ttlSec: z.number().int().min(60).max(7 * 86400).default(86400) });

@Controller("v1")
@UseGuards(AdminGuard)
export class CommandsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly commands: CommandsService,
  ) {}

  @Post("devices/:id/commands")
  async send(@CurrentPrincipal() p: Principal, @Param("id") id: string, @Body() body: unknown) {
    const b = parse(Body_, body);
    if (NOT_DIRECT.has(b.type)) throw new ForbiddenException({ code: "COMMAND_NOT_DIRECTLY_SENDABLE", type: b.type });
    const schemaFor = PAYLOADS[b.type];
    if (!schemaFor) throw new ForbiddenException({ code: "NOT_IMPLEMENTED", type: b.type });
    const payload = parse(schemaFor, b.payload);
    const d = await this.access.requireDevice(p, BASIC_COMMANDS.has(b.type) ? "command:send_basic" : "command:send", uuidParam(id));
    const row = await this.commands.create(d.ctx, { orgId: d.orgId, deviceId: d.id, type: b.type, payload, idempotencyKey: b.idempotencyKey, ttlSec: b.ttlSec, createdBy: p.userId });
    await withTenant(this.db, d.ctx, (tx) =>
      this.audit.log(tx, { organizationId: d.orgId, actorType: "USER", actorId: p.userId, action: "command.send", targetType: "DEVICE", targetId: d.id, data: { commandId: row.id, type: b.type }, ip: p.ip }),
    );
    return row;
  }

  @Get("devices/:id/commands")
  async list(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const d = await this.access.requireDevice(p, "device:read", uuidParam(id));
    return withTenant(this.db, d.ctx, (tx) => tx.select().from(schema.commands).where(eq(schema.commands.deviceId, d.id)).orderBy(desc(schema.commands.createdAt)).limit(100));
  }

  @Get("commands/:id")
  async get(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const cid = uuidParam(id);
    const out = await withTenant(this.db, this.access.ctxFor(p), async (tx) => {
      const [c] = await tx.select().from(schema.commands).where(eq(schema.commands.id, cid));
      if (!c) return null;
      const events = await tx.select().from(schema.commandEvents).where(eq(schema.commandEvents.commandId, cid)).orderBy(schema.commandEvents.createdAt);
      return { ...c, events };
    });
    if (!out) throw new NotFoundException({ code: "COMMAND_NOT_FOUND" });
    await this.access.requireDevice(p, "device:read", out.deviceId);
    return out;
  }

  @Post("commands/:id/cancel")
  async cancel(@CurrentPrincipal() p: Principal, @Param("id") id: string) {
    const cid = uuidParam(id);
    const [existing] = await withTenant(this.db, this.access.ctxFor(p), (tx) => tx.select().from(schema.commands).where(eq(schema.commands.id, cid)));
    if (!existing) throw new NotFoundException({ code: "COMMAND_NOT_FOUND" });
    const d = await this.access.requireDevice(p, "command:send_basic", existing.deviceId);
    return this.commands.cancel(d.ctx, cid);
  }
}
