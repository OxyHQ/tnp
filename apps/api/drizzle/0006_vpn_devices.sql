CREATE TABLE "vpn_address_quarantine" (
	"address" text PRIMARY KEY NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vpn_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"oxy_user_id" text NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_devices_public_key_key" ON "vpn_devices" USING btree ("public_key");--> statement-breakpoint
CREATE UNIQUE INDEX "vpn_devices_address_key" ON "vpn_devices" USING btree ("address");--> statement-breakpoint
CREATE INDEX "vpn_devices_oxy_user_id_idx" ON "vpn_devices" USING btree ("oxy_user_id");