-- id 계열을 bigint 에서 integer 로 좁힌다.
-- Prisma 가 생성한 diff 는 ALTER COLUMN ... SET DATA TYPE SERIAL 을 뱉는데,
-- SERIAL 은 CREATE TABLE 전용 축약어라 ALTER 에서는 실패한다. 또한 이 컬럼들은
-- GENERATED ALWAYS AS IDENTITY 라 Prisma 가 표현하지 못한다. 그래서 손으로 쓴다.
-- 타입만 바꾸므로 PK 는 재생성할 필요가 없다. FK 는 양쪽 타입이 같아야 해서 잠시 뗀다.

ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_item_id_fkey";

ALTER TABLE "items"           ALTER COLUMN "id"      SET DATA TYPE integer;
ALTER TABLE "stock_movements" ALTER COLUMN "id"      SET DATA TYPE integer;
ALTER TABLE "stock_movements" ALTER COLUMN "item_id" SET DATA TYPE integer;

ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
