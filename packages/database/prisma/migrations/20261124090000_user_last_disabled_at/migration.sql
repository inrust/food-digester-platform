-- Keep sessions established before account disablement from becoming valid again.
ALTER TABLE "users" ADD COLUMN "last_disabled_at" TIMESTAMPTZ;
