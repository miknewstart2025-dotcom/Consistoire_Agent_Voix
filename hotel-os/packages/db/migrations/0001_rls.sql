-- Row-Level Security: second isolation barrier behind the API guards.
-- The API connects with a login role that is a member of hotelos_app (no BYPASSRLS, not table owner).
-- Per transaction it sets:  app.org_ids = '{uuid,uuid}'  and/or  app.platform = 'on' (platform admin / system jobs).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotelos_app') THEN
    CREATE ROLE hotelos_app NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION hotelos_is_platform() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.platform', true), '') = 'on'
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION hotelos_org_allowed(org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT hotelos_is_platform()
      OR org = ANY (coalesce(nullif(current_setting('app.org_ids', true), ''), '{}')::uuid[])
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO hotelos_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hotelos_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_logs FROM hotelos_app;
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organizations USING (hotelos_org_allowed(id)) WITH CHECK (hotelos_is_platform());
--> statement-breakpoint
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_read ON audit_logs FOR SELECT USING (hotelos_is_platform() OR (organization_id IS NOT NULL AND hotelos_org_allowed(organization_id)));
--> statement-breakpoint
CREATE POLICY audit_insert ON audit_logs FOR INSERT WITH CHECK (organization_id IS NULL OR hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON subscriptions USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE hotels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON hotels USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON memberships USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE room_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON room_groups USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON rooms USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE room_group_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON room_group_members USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON devices USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE device_room_history ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON device_room_history USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE device_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON device_credentials USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE enrollment_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON enrollment_tokens USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE effective_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON effective_policies USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE device_app_inventory ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON device_app_inventory USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE commands ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON commands USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE command_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON command_events USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE stays ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON stays USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE cleanup_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON cleanup_jobs USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
--> statement-breakpoint
ALTER TABLE config_layers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY shared_read ON config_layers FOR SELECT USING (organization_id IS NULL OR hotelos_org_allowed(organization_id));
--> statement-breakpoint
CREATE POLICY tenant_write ON config_layers FOR ALL USING ((organization_id IS NULL AND hotelos_is_platform()) OR (organization_id IS NOT NULL AND hotelos_org_allowed(organization_id))) WITH CHECK ((organization_id IS NULL AND hotelos_is_platform()) OR (organization_id IS NOT NULL AND hotelos_org_allowed(organization_id)));
--> statement-breakpoint
ALTER TABLE apps ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY shared_read ON apps FOR SELECT USING (organization_id IS NULL OR hotelos_org_allowed(organization_id));
--> statement-breakpoint
CREATE POLICY tenant_write ON apps FOR ALL USING ((organization_id IS NULL AND hotelos_is_platform()) OR (organization_id IS NOT NULL AND hotelos_org_allowed(organization_id))) WITH CHECK ((organization_id IS NULL AND hotelos_is_platform()) OR (organization_id IS NOT NULL AND hotelos_org_allowed(organization_id)));
--> statement-breakpoint
ALTER TABLE app_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY shared_read ON app_versions FOR SELECT USING (organization_id IS NULL OR hotelos_org_allowed(organization_id));
--> statement-breakpoint
CREATE POLICY tenant_write ON app_versions FOR ALL USING ((organization_id IS NULL AND hotelos_is_platform()) OR (organization_id IS NOT NULL AND hotelos_org_allowed(organization_id))) WITH CHECK ((organization_id IS NULL AND hotelos_is_platform()) OR (organization_id IS NOT NULL AND hotelos_org_allowed(organization_id)));
