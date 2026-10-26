import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261019224326 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "print_trail_order" add column if not exists "dismissed_attention" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "print_trail_order" drop column if exists "dismissed_attention";`);
  }

}
