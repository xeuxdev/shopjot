ALTER TABLE "sales" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN "replaces_sale_id" uuid;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_store_id_replaces_sale_id_sales_store_id_id_fk" FOREIGN KEY ("store_id","replaces_sale_id") REFERENCES "public"."sales"("store_id","id") ON DELETE no action ON UPDATE no action;