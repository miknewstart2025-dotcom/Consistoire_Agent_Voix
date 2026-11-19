import { Controller, Get, Inject } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "./common/db.module";
import { DeviceConnections } from "./gateway/device-connections";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly conns: DeviceConnections,
  ) {}

  @Get()
  async health() {
    await this.pool.query("select 1");
    return { status: "ok", devicesOnline: this.conns.onlineCount() };
  }
}
