-- DEC-004@1.0.0：线协议和持久化统一为 Argon2id PHC password_hash。
-- 旧 verifier_* 列在兼容窗口内保留为 nullable；旧记录必须经受控密码轮换生成 PHC，
-- 不允许把无法证明参数的旧四组件直接拼接成 PHC。
ALTER TABLE "device_users"
  ADD COLUMN "password_hash" TEXT,
  ALTER COLUMN "verifier_value" DROP NOT NULL,
  ALTER COLUMN "verifier_salt" DROP NOT NULL;

ALTER TABLE "device_users"
  ADD CONSTRAINT "device_users_password_hash_argon2id_check"
  CHECK (
    "password_hash" IS NULL
    OR "password_hash" ~ '^\$argon2id\$v=19\$m=32768,t=3,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$'
  );

COMMENT ON COLUMN "device_users"."password_hash" IS
  'DEC-004@1.0.0 device-local Argon2id PHC; never returned by admin query APIs; only delivered by Device Sync';
