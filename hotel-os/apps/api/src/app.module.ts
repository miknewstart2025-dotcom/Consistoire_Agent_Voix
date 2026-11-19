import { type DynamicModule, Module } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { CatalogController } from "./catalog/catalog.controller";
import { CatalogService } from "./catalog/catalog.service";
import { RolloutsService } from "./catalog/rollouts.service";
import { StorageService } from "./catalog/storage.service";
import { CommandsController } from "./commands/commands.controller";
import { CommandsService } from "./commands/commands.service";
import { CommonModule } from "./common/common.module";
import { DbModule } from "./common/db.module";
import { APP_CONFIG, type AppConfig } from "./config";
import { DeviceApiController } from "./devices/device-api.controller";
import { DeviceAuthService } from "./devices/device-auth.service";
import { DeviceGuard } from "./devices/device.guard";
import { DevicesController } from "./devices/devices.controller";
import { DevicesService } from "./devices/devices.service";
import { DeviceConnections } from "./gateway/device-connections";
import { DeviceGateway } from "./gateway/device-gateway";
import { HealthController } from "./health.controller";
import { IptvController } from "./iptv/iptv.controller";
import { IptvService } from "./iptv/iptv.service";
import { SecretsService } from "./iptv/secrets.service";
import { ConfigController } from "./policy/config.controller";
import { PolicyService } from "./policy/policy.service";
import { SigningService } from "./policy/signing.service";
import { StaysController } from "./stays/stays.controller";
import { StaysService } from "./stays/stays.service";
import { HotelsController } from "./tenancy/hotels.controller";
import { OrganizationsController } from "./tenancy/organizations.controller";

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    const configModule: DynamicModule = { module: class ConfigHolder {}, global: true, providers: [{ provide: APP_CONFIG, useValue: cfg }], exports: [APP_CONFIG] };
    return {
      module: AppModule,
      imports: [configModule, DbModule, CommonModule, AuthModule],
      controllers: [
        HealthController,
        OrganizationsController,
        HotelsController,
        ConfigController,
        DevicesController,
        DeviceApiController,
        CommandsController,
        StaysController,
        IptvController,
        CatalogController,
      ],
      providers: [DeviceConnections, SigningService, PolicyService, CommandsService, DeviceAuthService, DeviceGuard, DevicesService, StaysService, DeviceGateway, SecretsService, IptvService, StorageService, CatalogService, RolloutsService],
    };
  }
}
