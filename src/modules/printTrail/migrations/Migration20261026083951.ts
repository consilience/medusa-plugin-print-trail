import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261026083951 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "print_trail_variant" drop constraint if exists "print_trail_variant_variant_id_unique";`);
    this.addSql(`create table if not exists "print_trail_variant" ("id" text not null, "variant_id" text not null, "product_id" text not null, "check_sku" text null, "check_status" text null, "check_matched_sku" text null, "check_note" text null, "checked_at" timestamptz null, "check_source" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "print_trail_variant_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_print_trail_variant_variant_id_unique" ON "print_trail_variant" ("variant_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_print_trail_variant_product_id" ON "print_trail_variant" ("product_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_print_trail_variant_check_status" ON "print_trail_variant" ("check_status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_print_trail_variant_deleted_at" ON "print_trail_variant" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "print_trail_variant" cascade;`);
  }

}
