ALTER TABLE "relays" ADD COLUMN "key_proven_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relays" ADD COLUMN "live_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_nodes" ADD COLUMN "relay_binding" jsonb;