import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3001),
  /** App login role (member of hotelos_app, subject to RLS). Never the owner role. */
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  JWT_TTL_SEC: z.coerce.number().default(900),
  /** PKCS#8 PEM of the ECDSA P-256 key used to sign device policies. */
  POLICY_SIGNING_KEY_PEM: z.string().optional(),
  /** Public base URL devices use for the WebSocket (wss://…/device/v1/ws). */
  PUBLIC_WS_URL: z.string().default("ws://localhost:3001/device/v1/ws"),
  /** Base URL where APK objects are served (CDN). */
  PUBLIC_DOWNLOAD_BASE: z.string().default("http://localhost:3001/downloads/"),
  AUTH_REQUIRE_TOTP: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  /** Key material for AES-GCM encryption of third-party credentials. Required in production. */
  SECRETS_KEY: z.string().min(32).optional(),
  /** Allow IPTV/EPG URLs on private networks (on-premise headends). Off by default (SSRF). */
  IPTV_ALLOW_PRIVATE_SOURCES: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
});
export type AppConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  if (parsed.data.NODE_ENV === "production" && !parsed.data.POLICY_SIGNING_KEY_PEM) {
    throw new Error("POLICY_SIGNING_KEY_PEM is required in production");
  }
  if (parsed.data.NODE_ENV === "production" && !parsed.data.SECRETS_KEY) {
    throw new Error("SECRETS_KEY is required in production");
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol("APP_CONFIG");
