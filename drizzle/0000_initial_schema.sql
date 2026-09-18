CREATE TYPE "public"."transaction_intent_status" AS ENUM('CREATED', 'PREPARED', 'SIMULATED', 'AWAITING_SIGNATURE', 'SIGNED', 'SUBMITTED', 'VALIDATED', 'REJECTED', 'EXPIRED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."transaction_intent_type" AS ENUM('PAYMENT', 'TRUST_SET');--> statement-breakpoint
CREATE TABLE "intent_transitions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"intent_id" uuid NOT NULL,
	"from_status" "transaction_intent_status",
	"to_status" "transaction_intent_status" NOT NULL,
	"reason_code" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transaction_intents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"request_hash" char(64) NOT NULL,
	"network_id" bigint NOT NULL,
	"intent_type" "transaction_intent_type" NOT NULL,
	"source_account" text NOT NULL,
	"status" "transaction_intent_status" NOT NULL,
	"intent_payload" jsonb NOT NULL,
	"prepared_tx_json" jsonb,
	"prepared_tx_blob" text,
	"prepared_ledger_index" bigint,
	"sequence" bigint,
	"fee_drops" numeric(30, 0),
	"last_ledger_sequence" bigint,
	"simulation_engine_result" text,
	"simulation_result" jsonb,
	"signed_tx_blob" text,
	"transaction_hash" char(64),
	"signing_pub_key" text,
	"submission_attempt_count" integer DEFAULT 0 NOT NULL,
	"submission_validated_ledger" bigint,
	"submit_engine_result" text,
	"submit_response" jsonb,
	"last_submit_attempt_at" timestamp with time zone,
	"final_result" text,
	"final_ledger_index" bigint,
	"final_ledger_hash" char(64),
	"final_tx_json" jsonb,
	"final_meta" jsonb,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prepared_at" timestamp with time zone,
	"simulated_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_intents_idempotency_key_key" UNIQUE("idempotency_key"),
	CONSTRAINT "transaction_intents_request_hash_check" CHECK ("transaction_intents"."request_hash" ~ '^[A-F0-9]{64}$'),
	CONSTRAINT "transaction_intents_transaction_hash_check" CHECK ("transaction_intents"."transaction_hash" IS NULL OR "transaction_intents"."transaction_hash" ~ '^[A-F0-9]{64}$'),
	CONSTRAINT "transaction_intents_network_id_check" CHECK ("transaction_intents"."network_id" BETWEEN 0 AND 4294967295),
	CONSTRAINT "transaction_intents_sequence_check" CHECK ("transaction_intents"."sequence" IS NULL OR "transaction_intents"."sequence" >= 0),
	CONSTRAINT "transaction_intents_fee_drops_check" CHECK ("transaction_intents"."fee_drops" IS NULL OR "transaction_intents"."fee_drops" > 0),
	CONSTRAINT "transaction_intents_prepared_ledger_index_check" CHECK ("transaction_intents"."prepared_ledger_index" IS NULL OR "transaction_intents"."prepared_ledger_index" > 0),
	CONSTRAINT "transaction_intents_last_ledger_sequence_check" CHECK ("transaction_intents"."last_ledger_sequence" IS NULL OR "transaction_intents"."last_ledger_sequence" > "transaction_intents"."prepared_ledger_index"),
	CONSTRAINT "transaction_intents_submission_attempt_count_check" CHECK ("transaction_intents"."submission_attempt_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "intent_transitions" ADD CONSTRAINT "intent_transitions_intent_id_transaction_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."transaction_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "intent_transitions_intent_id_id_idx" ON "intent_transitions" USING btree ("intent_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_intents_sequence_active_account_key" ON "transaction_intents" USING btree ("network_id","source_account") WHERE "transaction_intents"."status" IN ('PREPARED', 'SIMULATED', 'AWAITING_SIGNATURE', 'SIGNED', 'SUBMITTED');--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_intents_transaction_hash_key" ON "transaction_intents" USING btree ("transaction_hash") WHERE "transaction_intents"."transaction_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transaction_intents_status_idx" ON "transaction_intents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "transaction_intents_created_at_id_idx" ON "transaction_intents" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS LAST);