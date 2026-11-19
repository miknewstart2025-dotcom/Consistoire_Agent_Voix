import { BadRequestException, ConflictException, Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { type Db, schema, type TenantContext, withTenant } from "@hotel-os/db";
import { type CommandResult, type CommandType, type DeviceCommand, TERMINAL_COMMAND_STATUSES, type CommandStatus } from "@hotel-os/protocol";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { DB } from "../common/db.module";
import { DeviceConnections } from "../gateway/device-connections";

const SYSTEM: TenantContext = { orgIds: [], platform: true };

/** Allowed forward transitions. Anything else is ignored (idempotent device retries). */
const NEXT: Record<CommandStatus, CommandStatus[]> = {
  QUEUED: ["DELIVERED", "ACKED", "RUNNING", "SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED"],
  DELIVERED: ["ACKED", "RUNNING", "SUCCEEDED", "FAILED", "EXPIRED", "CANCELLED"],
  ACKED: ["RUNNING", "SUCCEEDED", "FAILED", "EXPIRED"],
  RUNNING: ["SUCCEEDED", "FAILED", "EXPIRED"],
  SUCCEEDED: [],
  FAILED: [],
  EXPIRED: [],
  CANCELLED: [],
};

type CommandRow = typeof schema.commands.$inferSelect;
export const toWire = (c: CommandRow): DeviceCommand => ({
  id: c.id,
  type: c.type as CommandType,
  payload: c.payload as Record<string, unknown>,
  createdAt: c.createdAt.toISOString(),
  expiresAt: c.expiresAt.toISOString(),
});

export type CommandListener = (c: CommandRow) => Promise<void> | void;

@Injectable()
export class CommandsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CommandsService.name);
  private timer?: NodeJS.Timeout;
  private readonly terminalListeners = new Map<string, CommandListener>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly conns: DeviceConnections,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.expireOld().catch((e) => this.log.error(e)), 60_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Lets other modules react when a command of a given type reaches a terminal state. */
  onTerminal(type: CommandType, fn: CommandListener) {
    this.terminalListeners.set(type, fn);
  }

  async create(
    ctx: TenantContext,
    input: { orgId: string; deviceId: string; type: CommandType; payload: Record<string, unknown>; idempotencyKey?: string; ttlSec: number; createdBy: string },
    tx?: Db,
  ): Promise<CommandRow> {
    const run = async (t: Db) => {
      if (input.idempotencyKey) {
        const [existing] = await t
          .select()
          .from(schema.commands)
          .where(and(eq(schema.commands.deviceId, input.deviceId), eq(schema.commands.idempotencyKey, input.idempotencyKey)));
        if (existing) {
          if (existing.type !== input.type) throw new ConflictException({ code: "IDEMPOTENCY_KEY_REUSED" });
          return { row: existing, isNew: false };
        }
      }
      const [row] = await t
        .insert(schema.commands)
        .values({
          organizationId: input.orgId,
          deviceId: input.deviceId,
          type: input.type,
          payload: input.payload,
          idempotencyKey: input.idempotencyKey,
          createdBy: input.createdBy,
          expiresAt: new Date(Date.now() + input.ttlSec * 1000),
        })
        .returning();
      await t.insert(schema.commandEvents).values({ organizationId: input.orgId, commandId: row.id, status: "QUEUED" });
      return { row, isNew: true };
    };
    const { row, isNew } = tx ? await run(tx) : await withTenant(this.db, ctx, run);
    // When called inside a caller's transaction, the caller must call dispatch() after commit.
    if (isNew && !tx) await this.dispatch(row);
    return row;
  }

  /** Pushes over WebSocket if the device is connected. Otherwise the device gets it by polling. */
  async dispatch(row: CommandRow): Promise<boolean> {
    if (!this.conns.send(row.deviceId, { t: "command", command: toWire(row) })) return false;
    await this.transition(row.deviceId, row.id, { status: "DELIVERED" } as never, "server");
    return true;
  }

  /** Pending (non-terminal, non-expired) commands for a device, oldest first. */
  async pendingFor(deviceId: string): Promise<CommandRow[]> {
    return withTenant(this.db, SYSTEM, (tx) =>
      tx
        .select()
        .from(schema.commands)
        .where(and(eq(schema.commands.deviceId, deviceId), inArray(schema.commands.status, ["QUEUED", "DELIVERED", "ACKED", "RUNNING"])))
        .orderBy(asc(schema.commands.createdAt)),
    ).then((rows) => rows.filter((r) => r.expiresAt > new Date()));
  }

  async markDelivered(deviceId: string, ids: string[]) {
    for (const id of ids) await this.transition(deviceId, id, { status: "DELIVERED" } as never, "server");
  }

  /**
   * Applies a status update reported by the device (or the server). Device can only touch its own commands.
   * Returns the updated row, or null when the transition is not allowed (ignored, idempotent).
   */
  async transition(
    deviceId: string,
    commandId: string,
    result: CommandResult | { status: "DELIVERED" },
    actor: "device" | "server",
  ): Promise<CommandRow | null> {
    const updated = await withTenant(this.db, SYSTEM, async (tx) => {
      const [c] = await tx.select().from(schema.commands).where(eq(schema.commands.id, commandId)).for("update");
      if (!c || c.deviceId !== deviceId) {
        if (actor === "device") throw new BadRequestException({ code: "UNKNOWN_COMMAND" });
        return null;
      }
      const to = result.status as CommandStatus;
      if (!NEXT[c.status].includes(to)) return null;
      const r = result as CommandResult;
      const [row] = await tx
        .update(schema.commands)
        .set({ status: to, resultMessage: r.message ?? c.resultMessage, resultData: r.data ?? c.resultData, updatedAt: new Date() })
        .where(eq(schema.commands.id, commandId))
        .returning();
      await tx.insert(schema.commandEvents).values({ organizationId: c.organizationId, commandId, status: to, message: r.message });
      return row;
    });
    if (updated && TERMINAL_COMMAND_STATUSES.has(updated.status)) {
      const l = this.terminalListeners.get(updated.type as CommandType);
      if (l) await l(updated);
    }
    return updated;
  }

  async cancel(ctx: TenantContext, commandId: string) {
    return withTenant(this.db, ctx, async (tx) => {
      const [c] = await tx.select().from(schema.commands).where(eq(schema.commands.id, commandId));
      if (!c) return null;
      if (!NEXT[c.status].includes("CANCELLED")) throw new ConflictException({ code: "NOT_CANCELLABLE", status: c.status });
      const [row] = await tx.update(schema.commands).set({ status: "CANCELLED", updatedAt: new Date() }).where(eq(schema.commands.id, commandId)).returning();
      await tx.insert(schema.commandEvents).values({ organizationId: c.organizationId, commandId, status: "CANCELLED" });
      return row;
    });
  }

  async expireOld() {
    const rows = await withTenant(this.db, SYSTEM, (tx) =>
      tx
        .update(schema.commands)
        .set({ status: "EXPIRED", updatedAt: new Date() })
        .where(and(inArray(schema.commands.status, ["QUEUED", "DELIVERED", "ACKED", "RUNNING"]), lt(schema.commands.expiresAt, new Date())))
        .returning(),
    );
    for (const r of rows) {
      const l = this.terminalListeners.get(r.type as CommandType);
      if (l) await l(r);
    }
    return rows.length;
  }
}
