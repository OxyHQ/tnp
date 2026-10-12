CREATE TABLE "vpn_address_quarantine" (
	"address" text PRIMARY KEY NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL
);
