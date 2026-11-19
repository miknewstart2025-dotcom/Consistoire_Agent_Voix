GRANT SELECT, INSERT, UPDATE, DELETE ON rollouts, rollout_targets TO hotelos_app;
--> statement-breakpoint
ALTER TABLE rollouts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY rollout_read ON rollouts FOR SELECT USING (organization_id IS NULL OR hotelos_org_allowed(organization_id));
--> statement-breakpoint
CREATE POLICY rollout_write ON rollouts FOR ALL USING ((organization_id IS NULL AND hotelos_is_platform()) OR (organization_id IS NOT NULL AND hotelos_org_allowed(organization_id))) WITH CHECK ((organization_id IS NULL AND hotelos_is_platform()) OR (organization_id IS NOT NULL AND hotelos_org_allowed(organization_id)));
--> statement-breakpoint
ALTER TABLE rollout_targets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON rollout_targets USING (hotelos_org_allowed(organization_id)) WITH CHECK (hotelos_org_allowed(organization_id));
