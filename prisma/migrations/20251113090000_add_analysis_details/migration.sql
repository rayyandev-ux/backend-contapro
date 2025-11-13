-- AlterTable: add JSONB column to store structured analysis details
ALTER TABLE "Analysis" ADD COLUMN "details" JSONB;