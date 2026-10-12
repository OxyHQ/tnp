CREATE TABLE "dns_rule_sets" (
	"oxy_user_id" text PRIMARY KEY NOT NULL,
	"envelope_version" integer NOT NULL,
	"kdf_params" jsonb NOT NULL,
	"salt" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"nonce" text NOT NULL,
	"ciphertext" text NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
