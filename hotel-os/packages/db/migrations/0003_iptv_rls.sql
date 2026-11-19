GRANT SELECT, INSERT, UPDATE, DELETE ON iptv_sources, channels, epg_programs TO hotelos_app;
--> statement-breakpoint
ALTER TABLE iptv_sources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON iptv_sources USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON channels USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE epg_programs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON epg_programs USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
