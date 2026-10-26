import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261019113359 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "print_trail_order" drop constraint if exists "print_trail_order_order_id_source_ref_unique";`);
    this.addSql(`alter table if exists "print_trail_order" add column if not exists "source_ref" text null, add column if not exists "cancel_status" text check ("cancel_status" in ('requested', 'awaiting', 'cancelled', 'too-late', 'refused', 'failed', 'not-sent')) null, add column if not exists "cancel_notified_at" timestamptz null, add column if not exists "address_hash" text null, add column if not exists "held_lines" jsonb null;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_print_trail_order_cancel_status" ON "print_trail_order" ("cancel_status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_print_trail_order_order_id_source_ref_unique" ON "print_trail_order" ("order_id", "source_ref") WHERE source_ref IS NOT NULL AND deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_print_trail_order_cancel_status";`);
    this.addSql(`drop index if exists "IDX_print_trail_order_order_id_source_ref_unique";`);
    this.addSql(`alter table if exists "print_trail_order" drop column if exists "source_ref", drop column if exists "cancel_status", drop column if exists "cancel_notified_at", drop column if exists "address_hash", drop column if exists "held_lines";`);
  }

}
