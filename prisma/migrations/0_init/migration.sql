-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "items" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'EA',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL,
    "item_id" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "items_sku_key" ON "items"("sku");

-- CreateIndex
CREATE INDEX "stock_movements_item_id_idx" ON "stock_movements"("item_id", "id");

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- CHECK 제약: Prisma 스키마 언어로 표현할 수 없어 여기에만 존재한다.
-- db pull 은 이 제약을 schema.prisma 로 되살리지 못하므로 삭제하지 말 것.
ALTER TABLE "items" ADD CONSTRAINT "items_sku_not_blank"
  CHECK (length(trim(both from "sku")) > 0);
ALTER TABLE "items" ADD CONSTRAINT "items_name_not_blank"
  CHECK (length(trim(both from "name")) > 0);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_nonzero"
  CHECK ("quantity" <> 0);
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_reason_not_blank"
  CHECK (length(trim(both from "reason")) > 0);
