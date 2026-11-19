CREATE TYPE "public"."app_source" AS ENUM('NATIVE', 'CATALOG', 'FIRST_PARTY');--> statement-breakpoint
CREATE TYPE "public"."certification_status" AS ENUM('CERTIFIED', 'PARTIAL', 'INCOMPATIBLE', 'PENDING');--> statement-breakpoint
CREATE TYPE "public"."cleanup_status" AS ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."command_status" AS ENUM('QUEUED', 'DELIVERED', 'ACKED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('PLATFORM_ADMIN', 'PARTNER_ADMIN', 'ORG_ADMIN', 'HOTEL_ADMIN', 'MANAGER', 'TECHNICIAN', 'READ_ONLY');--> statement-breakpoint
CREATE TYPE "public"."scope_type" AS ENUM('GLOBAL', 'ORG', 'HOTEL', 'GROUP', 'ROOM', 'DEVICE');--> statement-breakpoint
CREATE TYPE "public"."stay_status" AS ENUM('ACTIVE', 'CHECKED_OUT', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "app_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"app_id" uuid NOT NULL,
	"version_code" bigint NOT NULL,
	"version_name" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"signer_sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"min_sdk" integer,
	"target_sdk" integer,
	"abis" text[] DEFAULT '{}'::text[] NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"analysis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"distribution_rights_attested_by" uuid,
	"status" text DEFAULT 'UPLOADED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"package_name" text NOT NULL,
	"name" text NOT NULL,
	"source" "app_source" NOT NULL,
	"category" text,
	"description" text,
	"icon_url" text,
	"signer_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certification_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_model_id" uuid NOT NULL,
	"build_fingerprint" text,
	"report" jsonb NOT NULL,
	"verdict" "certification_status" DEFAULT 'PENDING' NOT NULL,
	"submitted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cleanup_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stay_id" uuid,
	"device_id" uuid NOT NULL,
	"command_id" uuid,
	"status" "cleanup_status" DEFAULT 'PENDING' NOT NULL,
	"report" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "command_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"status" "command_status" NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"status" "command_status" DEFAULT 'QUEUED' NOT NULL,
	"result_message" text,
	"result_data" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_layer_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"layer_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"values" jsonb NOT NULL,
	"locked_keys" text[] NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"scope_type" "scope_type" NOT NULL,
	"scope_id" text NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"locked_keys" text[] DEFAULT '{}'::text[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_app_inventory" (
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"package_name" text NOT NULL,
	"label" text,
	"version_code" bigint NOT NULL,
	"version_name" text,
	"system" boolean NOT NULL,
	"enabled" boolean NOT NULL,
	"suspended" boolean NOT NULL,
	"hidden" boolean NOT NULL,
	"has_launcher_entry" boolean NOT NULL,
	"signer_sha256" text,
	"can_suspend" boolean,
	"can_hide" boolean,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_app_inventory_device_id_package_name_pk" PRIMARY KEY("device_id","package_name")
);
--> statement-breakpoint
CREATE TABLE "device_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"public_key_spki" text NOT NULL,
	"fingerprint" text NOT NULL,
	"attestation" jsonb,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "device_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manufacturer" text NOT NULL,
	"model" text NOT NULL,
	"android_version" text,
	"api_level" integer,
	"specs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "certification_status" DEFAULT 'PENDING' NOT NULL,
	"capabilities" jsonb DEFAULT '{"lockTaskSupported":false,"persistentHomeSupported":false}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_room_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"room_id" uuid,
	"event" text NOT NULL,
	"actor_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"room_id" uuid,
	"device_model_id" uuid,
	"status" text DEFAULT 'ENROLLED' NOT NULL,
	"hardware" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_device_owner" boolean DEFAULT false NOT NULL,
	"kiosk_active" boolean DEFAULT false NOT NULL,
	"launcher_healthy" boolean DEFAULT false NOT NULL,
	"versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"telemetry" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy_version_applied" integer DEFAULT 0 NOT NULL,
	"reconcile_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pairing_code" text,
	"pairing_expires_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"last_state_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "effective_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"hash" text NOT NULL,
	"signed" jsonb NOT NULL,
	"explain" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollment_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "enrollment_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "hotels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"timezone" text DEFAULT 'Europe/Paris' NOT NULL,
	"default_language" text DEFAULT 'fr' NOT NULL,
	"languages" text[] DEFAULT '{fr,en}'::text[] NOT NULL,
	"contact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid,
	"role" "role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_id" uuid,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "room_group_members" (
	"organization_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "room_group_members_room_id_group_id_pk" PRIMARY KEY("room_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "room_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"number" text NOT NULL,
	"floor" text,
	"room_type" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"room_id" uuid NOT NULL,
	"status" "stay_status" DEFAULT 'ACTIVE' NOT NULL,
	"guest_first_name" text,
	"display_name_consent" boolean DEFAULT false NOT NULL,
	"language" text,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"pms_ref" text,
	"check_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_out_at" timestamp with time zone,
	"purged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"plan" text NOT NULL,
	"modules" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_rooms" integer,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certification_reports" ADD CONSTRAINT "certification_reports_device_model_id_device_models_id_fk" FOREIGN KEY ("device_model_id") REFERENCES "public"."device_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_jobs" ADD CONSTRAINT "cleanup_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_jobs" ADD CONSTRAINT "cleanup_jobs_stay_id_stays_id_fk" FOREIGN KEY ("stay_id") REFERENCES "public"."stays"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_jobs" ADD CONSTRAINT "cleanup_jobs_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanup_jobs" ADD CONSTRAINT "cleanup_jobs_command_id_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_events" ADD CONSTRAINT "command_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_events" ADD CONSTRAINT "command_events_command_id_commands_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."commands"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_layers" ADD CONSTRAINT "config_layers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_app_inventory" ADD CONSTRAINT "device_app_inventory_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_app_inventory" ADD CONSTRAINT "device_app_inventory_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_room_history" ADD CONSTRAINT "device_room_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_room_history" ADD CONSTRAINT "device_room_history_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_room_history" ADD CONSTRAINT "device_room_history_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_hotel_id_hotels_id_fk" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_device_model_id_device_models_id_fk" FOREIGN KEY ("device_model_id") REFERENCES "public"."device_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "effective_policies" ADD CONSTRAINT "effective_policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "effective_policies" ADD CONSTRAINT "effective_policies_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment_tokens" ADD CONSTRAINT "enrollment_tokens_hotel_id_hotels_id_fk" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hotels" ADD CONSTRAINT "hotels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_hotel_id_hotels_id_fk" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_group_members" ADD CONSTRAINT "room_group_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_group_members" ADD CONSTRAINT "room_group_members_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_group_members" ADD CONSTRAINT "room_group_members_group_id_room_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."room_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_groups" ADD CONSTRAINT "room_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_groups" ADD CONSTRAINT "room_groups_hotel_id_hotels_id_fk" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_hotel_id_hotels_id_fk" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stays" ADD CONSTRAINT "stays_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stays" ADD CONSTRAINT "stays_hotel_id_hotels_id_fk" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stays" ADD CONSTRAINT "stays_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_versions_app_code_uq" ON "app_versions" USING btree ("app_id","version_code");--> statement-breakpoint
CREATE UNIQUE INDEX "apps_org_pkg_uq" ON "apps" USING btree ("organization_id","package_name");--> statement-breakpoint
CREATE INDEX "audit_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "commands_device_status_idx" ON "commands" USING btree ("device_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "commands_idem_uq" ON "commands" USING btree ("device_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "config_layers_scope_uq" ON "config_layers" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_models_uq" ON "device_models" USING btree ("manufacturer","model");--> statement-breakpoint
CREATE INDEX "devices_hotel_idx" ON "devices" USING btree ("hotel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_pairing_code_uq" ON "devices" USING btree ("pairing_code");--> statement-breakpoint
CREATE UNIQUE INDEX "devices_one_active_per_room_uq" ON "devices" USING btree ("room_id") WHERE status in ('ENROLLED','ACTIVE') and room_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "effective_policies_device_version_uq" ON "effective_policies" USING btree ("device_id","version");--> statement-breakpoint
CREATE INDEX "hotels_org_idx" ON "hotels" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "room_groups_hotel_name_uq" ON "room_groups" USING btree ("hotel_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_hotel_number_uq" ON "rooms" USING btree ("hotel_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "stays_one_active_per_room_uq" ON "stays" USING btree ("room_id") WHERE status = 'ACTIVE';