import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261018163249 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "print_trail_state" drop constraint if exists "print_trail_state_key_unique";`);
    this.addSql(`alter table if exists "print_trail_order" drop constraint if exists "print_trail_order_order_id_sequence_unique";`);
    this.addSql(`create table if not exists "print_trail_order" ("id" text not null, "order_id" text not null, "sequence" integer not null default 1, "pt_order_number" text not null, "pt_uuid" text null, "print_trail_order_number" text null, "status" text null, "fulfillable_status" text null, "fulfilments" jsonb null, "errors" jsonb null, "submitted_lines" jsonb null, "block_reason" text null, "shortfall" jsonb null, "attention" text null, "confirmed_at" timestamptz null, "pending_action" text check ("pending_action" in ('send', 'confirm', 'cancel', 'amend', 'refetch')) null, "attempts" jsonb not null default '{}', "next_attempt_at" timestamptz null, "last_error" text null, "cancel_requested" boolean not null default false, "last_synced_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "print_trail_order_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_print_trail_order_order_id" ON "print_trail_order" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_print_trail_order_pt_uuid" ON "print_trail_order" ("pt_uuid") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_print_trail_order_next_attempt_at" ON "print_trail_order" ("next_attempt_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_print_trail_order_deleted_at" ON "print_trail_order" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_print_trail_order_order_id_sequence_unique" ON "print_trail_order" ("order_id", "sequence") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "print_trail_order_event" ("id" text not null, "order_id" text not null, "print_trail_order_id" text null, "kind" text not null, "message" text not null, "data" jsonb null, "customer_visible" boolean not null default false, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "print_trail_order_event_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_print_trail_order_event_order_id" ON "print_trail_order_event" ("order_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_print_trail_order_event_deleted_at" ON "print_trail_order_event" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "print_trail_state" ("id" text not null, "key" text not null, "value" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "print_trail_state_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_print_trail_state_key_unique" ON "print_trail_state" ("key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_print_trail_state_deleted_at" ON "print_trail_state" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "print_trail_order" cascade;`);

    this.addSql(`drop table if exists "print_trail_order_event" cascade;`);

    this.addSql(`drop table if exists "print_trail_state" cascade;`);
  }

}
