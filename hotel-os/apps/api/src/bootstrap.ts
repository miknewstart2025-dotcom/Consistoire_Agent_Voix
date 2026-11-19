import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import express from "express";
import type { Server } from "node:http";
import { AppModule } from "./app.module";
import type { AppConfig } from "./config";
import { DeviceGateway } from "./gateway/device-gateway";

export async function createApp(cfg: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(cfg), {
    bodyParser: true, logger: cfg.NODE_ENV === "test" ? ["error"] : ["log", "warn", "error"] });
  // APK uploads: raw body, size-bounded. Registered before Nest's JSON parser sees the request.
  app.use("/v1/catalog/apks", express.raw({ type: () => true, limit: `${cfg.MAX_APK_MB}mb` }));
  app.enableCors({ origin: cfg.CORS_ORIGINS.split(",").map((o) => o.trim()), credentials: false });
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable("x-powered-by");
  app.getHttpAdapter().getInstance().set("trust proxy", 1);
  const gateway = app.get(DeviceGateway);
  gateway.attach(app.getHttpServer() as Server);
  const close = app.close.bind(app);
  app.close = async () => {
    gateway.close();
    await close();
  };
  return app;
}
