CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"phone" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_store_id_unique" UNIQUE("store_id","id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sale_id" uuid NOT NULL,
	"amount_kobo" bigint NOT NULL,
	"method" text,
	"received_at" timestamp with time zone NOT NULL,
	"reversal_of" uuid,
	CONSTRAINT "payments_store_id_unique" UNIQUE("store_id","id"),
	CONSTRAINT "payment_amount_valid" CHECK ("payments"."amount_kobo" between 1 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "processed_sync_operations" (
	"store_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"result" jsonb NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_sync_operations_store_id_operation_id_pk" PRIMARY KEY("store_id","operation_id")
);
--> statement-breakpoint
CREATE TABLE "product_units" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"product_id" uuid NOT NULL,
	"label" text NOT NULL,
	"normalized_label" text NOT NULL,
	"suggested_unit_price_kobo" bigint NOT NULL,
	"quantity_on_hand" numeric(16, 3) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "units_store_id_unique" UNIQUE("store_id","id"),
	CONSTRAINT "unit_price_valid" CHECK ("product_units"."suggested_unit_price_kobo" between 0 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_store_id_unique" UNIQUE("store_id","id")
);
--> statement-breakpoint
CREATE TABLE "sale_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sale_id" uuid NOT NULL,
	"product_unit_id" uuid,
	"name_snapshot" text NOT NULL,
	"quantity_decimal" numeric(16, 3) NOT NULL,
	"quantity_label_snapshot" text NOT NULL,
	"unit_price_kobo" bigint NOT NULL,
	"line_total_kobo" bigint NOT NULL,
	CONSTRAINT "items_store_id_unique" UNIQUE("store_id","id"),
	CONSTRAINT "item_quantity_positive" CHECK ("sale_items"."quantity_decimal" > 0),
	CONSTRAINT "item_price_valid" CHECK ("sale_items"."unit_price_kobo" between 0 and 9007199254740991),
	CONSTRAINT "item_total_valid" CHECK ("sale_items"."line_total_kobo" between 0 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" uuid NOT NULL,
	"total_kobo" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_store_id_unique" UNIQUE("store_id","id"),
	CONSTRAINT "sale_total_valid" CHECK ("sales"."total_kobo" between 0 and 9007199254740991),
	CONSTRAINT "sale_status_valid" CHECK ("sales"."status" in ('active', 'voided'))
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"product_unit_id" uuid NOT NULL,
	"sale_item_id" uuid,
	"quantity_delta_decimal" numeric(16, 3) NOT NULL,
	"reason" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "movement_reason_valid" CHECK ("stock_movements"."reason" in ('initial_stock', 'sale', 'manual_adjustment', 'reversal'))
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Africa/Lagos' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_changes" (
	"change_id" bigserial PRIMARY KEY NOT NULL,
	"store_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_store_id_sale_id_sales_store_id_id_fk" FOREIGN KEY ("store_id","sale_id") REFERENCES "public"."sales"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_store_id_reversal_of_payments_store_id_id_fk" FOREIGN KEY ("store_id","reversal_of") REFERENCES "public"."payments"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_sync_operations" ADD CONSTRAINT "processed_sync_operations_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_units" ADD CONSTRAINT "product_units_store_id_product_id_products_store_id_id_fk" FOREIGN KEY ("store_id","product_id") REFERENCES "public"."products"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_store_id_sale_id_sales_store_id_id_fk" FOREIGN KEY ("store_id","sale_id") REFERENCES "public"."sales"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_store_id_product_unit_id_product_units_store_id_id_fk" FOREIGN KEY ("store_id","product_unit_id") REFERENCES "public"."product_units"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_store_id_customer_id_customers_store_id_id_fk" FOREIGN KEY ("store_id","customer_id") REFERENCES "public"."customers"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_store_id_product_unit_id_product_units_store_id_id_fk" FOREIGN KEY ("store_id","product_unit_id") REFERENCES "public"."product_units"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_store_id_sale_item_id_sale_items_store_id_id_fk" FOREIGN KEY ("store_id","sale_item_id") REFERENCES "public"."sale_items"("store_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("store_id","normalized_name");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_reversal_unique" ON "payments" USING btree ("reversal_of");--> statement-breakpoint
CREATE INDEX "payments_sale_idx" ON "payments" USING btree ("store_id","sale_id");--> statement-breakpoint
CREATE INDEX "payments_received_idx" ON "payments" USING btree ("store_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "units_product_label_unique" ON "product_units" USING btree ("product_id","normalized_label");--> statement-breakpoint
CREATE INDEX "products_name_idx" ON "products" USING btree ("store_id","normalized_name");--> statement-breakpoint
CREATE INDEX "items_sale_idx" ON "sale_items" USING btree ("store_id","sale_id");--> statement-breakpoint
CREATE INDEX "sales_occurred_idx" ON "sales" USING btree ("store_id","occurred_at");--> statement-breakpoint
CREATE INDEX "sales_customer_idx" ON "sales" USING btree ("store_id","customer_id");--> statement-breakpoint
CREATE INDEX "movements_unit_idx" ON "stock_movements" USING btree ("store_id","product_unit_id");--> statement-breakpoint
CREATE INDEX "changes_store_cursor_idx" ON "sync_changes" USING btree ("store_id","change_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");