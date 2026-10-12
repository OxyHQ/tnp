CREATE TABLE "domain_key_tombstones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"tld" text NOT NULL,
	"domain_key" text NOT NULL,
	"rotations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "domain_key" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "domain_key_rotations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "domain_key_reset_from" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "domain_key_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_nodes" ADD COLUMN "chain" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "service_nodes" ADD COLUMN "ka_cert" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_key_tombstones_name_tld_key" ON "domain_key_tombstones" USING btree ("name","tld");