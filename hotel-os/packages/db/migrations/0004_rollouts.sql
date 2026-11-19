CREATE TYPE "public"."rollout_status" AS ENUM('RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."rollout_target_state" AS ENUM('WAITING', 'TARGETED', 'SUCCEEDED', 'FAILED', 'SKIPPED_INCOMPATIBLE');--> statement-breakpoint
CREATE TABLE "rollout_targets" (
	"rollout_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"ring" integer NOT NULL,
	"state" "rollout_target_state" DEFAULT 'WAITING' NOT NULL,
	"message" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rollout_targets_rollout_id_device_id_pk" PRIMARY KEY("rollout_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "rollouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"app_version_id" uuid NOT NULL,
	"package_name" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"rings" integer[] NOT NULL,
	"current_ring" integer DEFAULT 0 NOT NULL,
	"status" "rollout_status" DEFAULT 'RUNNING' NOT NULL,
	"failure_threshold_pct" integer DEFAULT 10 NOT NULL,
	"auto_advance" boolean DEFAULT false NOT NULL,
	"update_window" text DEFAULT 'MAINTENANCE' NOT NULL,
	"paused_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rollout_targets" ADD CONSTRAINT "rollout_targets_rollout_id_rollouts_id_fk" FOREIGN KEY ("rollout_id") REFERENCES "public"."rollouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollout_targets" ADD CONSTRAINT "rollout_targets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollout_targets" ADD CONSTRAINT "rollout_targets_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollouts" ADD CONSTRAINT "rollouts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rollouts" ADD CONSTRAINT "rollouts_app_version_id_app_versions_id_fk" FOREIGN KEY ("app_version_id") REFERENCES "public"."app_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rollout_targets_device_idx" ON "rollout_targets" USING btree ("device_id");