CREATE TYPE "public"."dns_record_type" AS ENUM('A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('active', 'pending', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."node_status" AS ENUM('online', 'offline');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('open', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."relay_operator" AS ENUM('oxy', 'community');--> statement-breakpoint
CREATE TYPE "public"."relay_status" AS ENUM('active', 'degraded', 'offline');--> statement-breakpoint
CREATE TYPE "public"."tld_status" AS ENUM('active', 'proposed', 'pending');--> statement-breakpoint
CREATE TYPE "public"."vote_direction" AS ENUM('up', 'down');--> statement-breakpoint
CREATE TABLE "dns_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"type" "dns_record_type" NOT NULL,
	"name" text DEFAULT '@' NOT NULL,
	"value" text NOT NULL,
	"ttl" integer DEFAULT 3600 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"tld" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"oxy_user_id" text NOT NULL,
	"status" "domain_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "relays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint" text NOT NULL,
	"public_key" text NOT NULL,
	"operator" "relay_operator" NOT NULL,
	"operator_user_id" text NOT NULL,
	"max_connections" integer NOT NULL,
	"bandwidth" integer NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"status" "relay_status" DEFAULT 'offline' NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain_id" uuid NOT NULL,
	"oxy_user_id" text NOT NULL,
	"public_key" text NOT NULL,
	"connected_relay" text DEFAULT '' NOT NULL,
	"status" "node_status" DEFAULT 'offline' NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tld_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tld" text NOT NULL,
	"proposed_by_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" "proposal_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tlds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"status" "tld_status" DEFAULT 'proposed' NOT NULL,
	"custom" boolean DEFAULT true NOT NULL,
	"proposed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"oxy_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"direction" "vote_direction" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dns_records" ADD CONSTRAINT "dns_records_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_nodes" ADD CONSTRAINT "service_nodes_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tld_proposals" ADD CONSTRAINT "tld_proposals_proposed_by_id_users_id_fk" FOREIGN KEY ("proposed_by_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tlds" ADD CONSTRAINT "tlds_proposed_by_id_users_id_fk" FOREIGN KEY ("proposed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_proposal_id_tld_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."tld_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dns_records_lookup_idx" ON "dns_records" USING btree ("domain_id","name","type");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_name_tld_key" ON "domains" USING btree ("name","tld");--> statement-breakpoint
CREATE INDEX "domains_oxy_user_id_idx" ON "domains" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE INDEX "domains_owner_id_idx" ON "domains" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relays_endpoint_key" ON "relays" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "relays_operator_user_id_idx" ON "relays" USING btree ("operator_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_nodes_domain_id_key" ON "service_nodes" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "service_nodes_oxy_user_id_idx" ON "service_nodes" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tlds_name_key" ON "tlds" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "users_oxy_user_id_key" ON "users" USING btree ("oxy_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "votes_proposal_user_key" ON "votes" USING btree ("proposal_id","user_id");--> statement-breakpoint
CREATE INDEX "votes_proposal_id_idx" ON "votes" USING btree ("proposal_id");