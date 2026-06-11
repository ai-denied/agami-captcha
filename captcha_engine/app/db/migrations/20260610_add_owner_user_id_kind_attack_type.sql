-- ---------------------------------------------------------------------------
-- 소유 체인(owner_user_id) + 검증 종류/공격유형 컬럼 추가
-- ---------------------------------------------------------------------------
-- 이 repo 는 Alembic 을 쓰지 않으므로(수동 schema.sql 관리), 멱등 ALTER 로 작성.
-- 이미 수동 ALTER 된 환경에서도 충돌 없이 재실행 가능하도록 IF NOT EXISTS 사용.
--
-- 소유 체인: api_keys.owner_user_id → challenges.owner_user_id → verifications.owner_user_id
-- 전부 nullable. owner_user_id 는 JWT 검증 미들웨어 도입 전까지 NULL 로 둔다.
--
-- 적용:
--   psql -U captcha_user -d captcha_db -f 20260610_add_owner_user_id_kind_attack_type.sql
-- ---------------------------------------------------------------------------

ALTER TABLE api_keys      ADD COLUMN IF NOT EXISTS owner_user_id INTEGER;

ALTER TABLE challenges    ADD COLUMN IF NOT EXISTS owner_user_id INTEGER;

ALTER TABLE verifications ADD COLUMN IF NOT EXISTS owner_user_id INTEGER;
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS kind          VARCHAR(32);
ALTER TABLE verifications ADD COLUMN IF NOT EXISTS attack_type   VARCHAR(32);
