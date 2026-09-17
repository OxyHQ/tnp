CREATE TYPE "public"."audit_actor_kind" AS ENUM('user', 'system', 'support');--> statement-breakpoint
CREATE TYPE "public"."contact_role" AS ENUM('registrant', 'admin', 'tech', 'billing');--> statement-breakpoint
CREATE TYPE "public"."dns_authority" AS ENUM('provider', 'external');--> statement-breakpoint
CREATE TYPE "public"."dns_zone_state" AS ENUM('unmanaged', 'in_sync', 'pending', 'conflict', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."operation_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'unknown', 'manual_review');--> statement-breakpoint
CREATE TYPE "public"."order_line_state" AS ENUM('pending', 'fulfilling', 'succeeded', 'failed', 'unknown', 'manual_review');--> statement-breakpoint
CREATE TYPE "public"."order_state" AS ENUM('awaiting_payment', 'paid', 'fulfilling', 'completed', 'partially_completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_state" AS ENUM('none', 'authorized', 'captured', 'refunded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."provider_environment" AS ENUM('sandbox', 'production');--> statement-breakpoint
CREATE TYPE "public"."provider_management_mode" AS ENUM('active', 'read_only', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."provider_sales_state" AS ENUM('enabled', 'sales_disabled');--> statement-breakpoint
CREATE TYPE "public"."public_domain_lifecycle" AS ENUM('pending', 'active', 'expired', 'redemption', 'transferring_in', 'transferred_out', 'locked_by_registry', 'failed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."quote_operation" AS ENUM('register', 'renew', 'transfer_in');--> statement-breakpoint
CREATE TYPE "public"."rate_window_kind" AS ENUM('minute', 'hour', 'day');--> statement-breakpoint
CREATE TYPE "public"."renewal_owner" AS ENUM('none', 'tnp', 'provider');--> statement-breakpoint
CREATE TYPE "public"."zone_snapshot_source" AS ENUM('observed', 'applied');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_kind" "audit_actor_kind" NOT NULL,
	"actor_oxy_user_id" text,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid,
	"correlation_id" uuid,
	"outcome" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_user_actor_named" CHECK ("audit_events"."actor_kind" = 'system' or "audit_events"."actor_oxy_user_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "dns_zone_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"zone_id" uuid NOT NULL,
	"source" "zone_snapshot_source" NOT NULL,
	"hash" text NOT NULL,
	"zone" jsonb NOT NULL,
	"operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dns_zones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_domain_id" uuid NOT NULL,
	"authority" "dns_authority" NOT NULL,
	"provider_account_id" uuid,
	"state" "dns_zone_state" DEFAULT 'unmanaged' NOT NULL,
	"observed_hash" text,
	"observed_at" timestamp with time zone,
	"desired_version" integer DEFAULT 0 NOT NULL,
	"applied_version" integer DEFAULT 0 NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dns_zones_public_domain_key" UNIQUE("public_domain_id"),
	CONSTRAINT "dns_zones_provider_authority_has_account" CHECK ("dns_zones"."authority" <> 'provider' or "dns_zones"."provider_account_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "domain_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"public_domain_id" uuid NOT NULL,
	"role" "contact_role" NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_contacts_domain_role_key" UNIQUE("public_domain_id","role")
);
--> statement-breakpoint
CREATE TABLE "operation_resource_leases" (
	"resource_key" text PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"idempotency_scope" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"intent_hash" text NOT NULL,
	"owner_id" uuid,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"provider_account_id" uuid,
	"payload" jsonb NOT NULL,
	"status" "operation_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"resubmissions" integer DEFAULT 0 NOT NULL,
	"reconcile_attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result" jsonb,
	"error_code" text,
	"error_message" text,
	"correlation_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_idempotency_key" UNIQUE("idempotency_scope","idempotency_key"),
	CONSTRAINT "operations_attempts_non_negative" CHECK ("operations"."attempts" >= 0),
	CONSTRAINT "operations_lease_consistent" CHECK (("operations"."status" = 'running') = ("operations"."lease_owner" is not null and "operations"."lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"state" "order_line_state" DEFAULT 'pending' NOT NULL,
	"price_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"public_domain_id" uuid,
	"operation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_lines_quote_key" UNIQUE("quote_id")
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"state" "order_state" DEFAULT 'awaiting_payment' NOT NULL,
	"payment_state" "payment_state" DEFAULT 'none' NOT NULL,
	"payment_reference" text,
	"currency" char(3) NOT NULL,
	"total_minor" bigint NOT NULL,
	"idempotency_key" text NOT NULL,
	"intent_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_owner_idempotency_key" UNIQUE("owner_id","idempotency_key"),
	CONSTRAINT "orders_total_non_negative" CHECK ("orders"."total_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adapter" text NOT NULL,
	"environment" "provider_environment" NOT NULL,
	"label" text NOT NULL,
	"sales_state" "provider_sales_state" DEFAULT 'sales_disabled' NOT NULL,
	"management_mode" "provider_management_mode" DEFAULT 'read_only' NOT NULL,
	"secret_ref" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_accounts_adapter_env_label_key" UNIQUE("adapter","environment","label"),
	CONSTRAINT "provider_accounts_secret_ref_scheme" CHECK ("provider_accounts"."secret_ref" is null or "provider_accounts"."secret_ref" ~ '^env:[A-Z][A-Z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "provider_rate_windows" (
	"provider_account_id" uuid NOT NULL,
	"window" "rate_window_kind" NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "public_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"ascii_name" text NOT NULL,
	"unicode_name" text NOT NULL,
	"suffix" text NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"remote_id" text,
	"lifecycle" "public_domain_lifecycle" DEFAULT 'pending' NOT NULL,
	"registrar_status" text,
	"registered_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"locked" boolean,
	"privacy" boolean,
	"renewal_owner" "renewal_owner" DEFAULT 'none' NOT NULL,
	"renewal_consent_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_domains_ascii_canonical" CHECK ("public_domains"."ascii_name" = lower("public_domains"."ascii_name") and "public_domains"."ascii_name" not like '%.'),
	CONSTRAINT "public_domains_renewal_consent" CHECK ("public_domains"."renewal_owner" <> 'tnp' or "public_domains"."renewal_consent_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"operation" "quote_operation" NOT NULL,
	"ascii_name" text NOT NULL,
	"unicode_name" text NOT NULL,
	"suffix" text NOT NULL,
	"years" integer NOT NULL,
	"currency" char(3) NOT NULL,
	"cost_minor" bigint NOT NULL,
	"fees_minor" bigint DEFAULT 0 NOT NULL,
	"price_minor" bigint NOT NULL,
	"renewal_price_minor" bigint,
	"premium" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quotes_years_range" CHECK ("quotes"."years" between 1 and 10),
	CONSTRAINT "quotes_amounts_non_negative" CHECK ("quotes"."cost_minor" >= 0 and "quotes"."fees_minor" >= 0 and "quotes"."price_minor" >= 0)
);
--> statement-breakpoint
ALTER TABLE "dns_zone_snapshots" ADD CONSTRAINT "dns_zone_snapshots_zone_id_dns_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."dns_zones"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_zones" ADD CONSTRAINT "dns_zones_public_domain_id_public_domains_id_fk" FOREIGN KEY ("public_domain_id") REFERENCES "public"."public_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_zones" ADD CONSTRAINT "dns_zones_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domain_contacts" ADD CONSTRAINT "domain_contacts_public_domain_id_public_domains_id_fk" FOREIGN KEY ("public_domain_id") REFERENCES "public"."public_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_resource_leases" ADD CONSTRAINT "operation_resource_leases_operation_id_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_public_domain_id_public_domains_id_fk" FOREIGN KEY ("public_domain_id") REFERENCES "public"."public_domains"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_rate_windows" ADD CONSTRAINT "provider_rate_windows_account_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_domains" ADD CONSTRAINT "public_domains_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_domains" ADD CONSTRAINT "public_domains_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_provider_account_id_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."provider_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_resource_idx" ON "audit_events" USING btree ("resource_type","resource_id","created_at");--> statement-breakpoint
CREATE INDEX "dns_zone_snapshots_zone_idx" ON "dns_zone_snapshots" USING btree ("zone_id","created_at");--> statement-breakpoint
CREATE INDEX "operations_claim_idx" ON "operations" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "operations_resource_idx" ON "operations" USING btree ("resource_type","resource_id","created_at");--> statement-breakpoint
CREATE INDEX "order_lines_order_idx" ON "order_lines" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_owner_idx" ON "orders" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_rate_windows_key" ON "provider_rate_windows" USING btree ("provider_account_id","window","window_start");--> statement-breakpoint
CREATE UNIQUE INDEX "public_domains_account_name_live_key" ON "public_domains" USING btree ("provider_account_id","ascii_name") WHERE "public_domains"."lifecycle" not in ('failed', 'transferred_out');--> statement-breakpoint
CREATE INDEX "public_domains_owner_idx" ON "public_domains" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "public_domains_expiry_idx" ON "public_domains" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "quotes_owner_idx" ON "quotes" USING btree ("owner_id","created_at");