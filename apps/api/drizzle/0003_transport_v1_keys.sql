ALTER TABLE "domains" ADD COLUMN "domain_key" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "domain_key_rotations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "service_nodes" ADD COLUMN "chain" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "service_nodes" ADD COLUMN "ka_cert" jsonb;