import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261020090557 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "print_trail_order" add column if not exists "pre_order_fulfilments" jsonb null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "print_trail_order" drop column if exists "pre_order_fulfilments";`);
  }

}
