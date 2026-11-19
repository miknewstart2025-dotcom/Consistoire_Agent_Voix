CREATE TABLE "channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"epg_id" text,
	"logo_url" text,
	"category" text,
	"language" text,
	"stream_url" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "epg_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"epg_id" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"stop" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" text
);
--> statement-breakpoint
CREATE TABLE "iptv_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"hotel_id" uuid NOT NULL,
	"name" text NOT NULL,
	"playlist_url" text NOT NULL,
	"epg_url" text,
	"credentials_enc" text,
	"rights_attested_by" uuid NOT NULL,
	"rights_attested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_status" text,
	"last_sync_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_hotel_id_hotels_id_fk" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_source_id_iptv_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."iptv_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epg_programs" ADD CONSTRAINT "epg_programs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "epg_programs" ADD CONSTRAINT "epg_programs_source_id_iptv_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."iptv_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iptv_sources" ADD CONSTRAINT "iptv_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "iptv_sources" ADD CONSTRAINT "iptv_sources_hotel_id_hotels_id_fk" FOREIGN KEY ("hotel_id") REFERENCES "public"."hotels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_source_stream_uq" ON "channels" USING btree ("source_id","stream_url");--> statement-breakpoint
CREATE INDEX "channels_hotel_idx" ON "channels" USING btree ("hotel_id");--> statement-breakpoint
CREATE INDEX "epg_source_channel_start_idx" ON "epg_programs" USING btree ("source_id","epg_id","start");