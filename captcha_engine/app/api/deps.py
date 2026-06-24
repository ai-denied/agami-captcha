from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from urllib.parse import urlparse

import jwt
import redis.asyncio as redis_async
from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.policy import (
    DEFAULT_PER_IP_LIMIT_PER_MIN,
    RATE_LIMIT_WINDOW_SEC,
    is_rate_limited,
)
from app.cache.challenge_store import (
    ChallengeStore,
    k_rate_apikey,
    k_rate_ip,
)
from app.cache.redis_client import get_redis_client
from app.core.config import get_settings
from app.db.models import AllowedOrigin, ApiKey, TenantSettings
from app.db.session import get_sessionmaker

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 인프라
# ---------------------------------------------------------------------------

async def get_db() -> AsyncIterator[AsyncSession]:
    """async DB 세션. 요청 단위 lifecycle."""
    sm = get_sessionmaker()
    async with sm() as session:
        yield session


def get_redis() -> redis_async.Redis:
    return get_redis_client()


def get_store(redis: redis_async.Redis = Depends(get_redis)) -> ChallengeStore:
    return ChallengeStore(redis)


# ---------------------------------------------------------------------------
# 인증
# ---------------------------------------------------------------------------

async def verify_client_key(
    x_captcha_client_key: str = Header(..., alias="X-Captcha-Client-Key"),
    db: AsyncSession = Depends(get_db),
) -> ApiKey:
    """
    헤더로 들어온 client_key 가 활성 API key 인지 확인.
    revoked 된 키는 거부.
    """
    stmt = select(ApiKey).where(
        ApiKey.client_key == x_captcha_client_key,
        ApiKey.revoked_at.is_(None),
    )
    api_key = (await db.execute(stmt)).scalar_one_or_none()
    if api_key is None:
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_client_key", "message": "Unknown or revoked client key."},
        )
    return api_key


def _origin_matches(allowed: str, incoming: str) -> bool:
    """등록 origin(allowed)에 대해 요청 origin(incoming)이 매칭되는지 판정.

    통상 캡차 방식: 스킴 일치 + (hostname 정확일치 OR 서브도메인). 포트/경로는 무시.
    - 스킴이 다르면 거부 (https 등록 → http 요청 다운그레이드 차단).
    - hostname 정확일치 또는 점(.) 경계 서브도메인만 허용.
      → app.example.com 은 example.com 에 매칭, evilexample.com / example.com.evil.com 은 매칭 안 됨.
    - 어느 쪽이든 hostname 이 비었으면(파싱 실패 포함) 거부.
    urlparse.hostname 은 포트를 제외하고 소문자로 정규화한다.
    """
    a = urlparse(allowed)
    i = urlparse(incoming)
    if a.scheme != i.scheme:
        return False
    a_host, i_host = a.hostname, i.hostname
    if not a_host or not i_host:
        return False
    return i_host == a_host or i_host.endswith("." + a_host)


async def verify_origin(
    request: Request,
    api_key: ApiKey = Depends(verify_client_key),
    db: AsyncSession = Depends(get_db),
) -> ApiKey:
    """
    Origin 헤더가 해당 api_key(프로젝트)의 allowed_origins 화이트리스트에 있는지 확인.
    Origin 이 없는 요청 (서버-서버, curl 테스트 등) 은 통과.
    정확일치 + 서브도메인 자동 포함 (_origin_matches 참고).
    """
    origin = request.headers.get("origin")
    if not origin:
        return api_key

    # 수정됨: tenant_id가 아닌 api_key_id를 기준으로 프로젝트 도메인 목록을 가져와 매칭
    stmt = select(AllowedOrigin.origin).where(AllowedOrigin.api_key_id == api_key.id)
    allowed_list = (await db.execute(stmt)).scalars().all()
    if not any(_origin_matches(allowed, origin) for allowed in allowed_list):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "origin_not_allowed",
                "message": f"Origin {origin} is not allowed for this site key.",
            },
        )
    return api_key


# ---------------------------------------------------------------------------
# Rate Limit (#45)
# ---------------------------------------------------------------------------

async def enforce_rate_limit(
    request: Request,
    api_key: ApiKey = Depends(verify_origin),
    db: AsyncSession = Depends(get_db),
    store: ChallengeStore = Depends(get_store),
) -> ApiKey:
    """
    요청 단위 rate limit. IP 와 API key 양쪽을 1분 창으로 카운트.
    한도 초과 시 429 + Retry-After 헤더.

    한도 산정:
    - API key 한도 = tenant_settings.rate_limit_per_min (없으면 시스템 기본값)
    - IP 한도 = DEFAULT_PER_IP_LIMIT_PER_MIN (단일 IP 폭주 차단)
    """
    settings = get_settings()
    ip = request.client.host if request.client else "unknown"

    # 카운터 두 개를 동시에 증가 (round-trip 한 번에)
    ip_count = await store.incr_rate_counter(
        k_rate_ip(ip, "1m"), RATE_LIMIT_WINDOW_SEC
    )
    apikey_count = await store.incr_rate_counter(
        k_rate_apikey(api_key.client_key, "1m"), RATE_LIMIT_WINDOW_SEC
    )

    # tenant 별 한도 조회. 없으면 시스템 기본.
    ts = (
        await db.execute(
            select(TenantSettings).where(TenantSettings.tenant_id == api_key.tenant_id)
        )
    ).scalar_one_or_none()
    apikey_limit = ts.rate_limit_per_min if ts else settings.default_rate_limit_per_min

    if is_rate_limited(ip_count, DEFAULT_PER_IP_LIMIT_PER_MIN):
        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limit_exceeded",
                "message": "Too many requests from this IP. Please retry later.",
                "scope": "ip",
            },
            headers={"Retry-After": str(RATE_LIMIT_WINDOW_SEC)},
        )
    if is_rate_limited(apikey_count, apikey_limit):
        raise HTTPException(
            status_code=429,
            detail={
                "code": "rate_limit_exceeded",
                "message": "Too many requests for this API key. Please retry later.",
                "scope": "api_key",
            },
            headers={"Retry-After": str(RATE_LIMIT_WINDOW_SEC)},
        )

    return api_key


# ---------------------------------------------------------------------------
# 로그인 사용자 JWT 인증 (agamidb 발급 HS256)
# ---------------------------------------------------------------------------
# ⚠️ 이건 전역 미들웨어가 아니라 "로그인 사용자 전용 라우트"에만 선택 적용하는
#    FastAPI 의존성이다. 기존 client_key 기반 siteverify/발급/검증 플로우와 완전히
#    분리되어 있으며, 그쪽 인증(verify_client_key/enforce_rate_limit)은 건드리지 않는다.
#
# 토큰 전달: Authorization 헤더가 아니라 'accessToken' HttpOnly 쿠키.
#           (캡챠와 로그인 앱이 same-origin 이라 요청에 자동 첨부됨.)
# payload: sub=str(user.id), nickname, exp. iss/aud 없음.

async def get_current_user_id(request: Request) -> int:
    """accessToken 쿠키의 JWT 를 검증하고 user.id(int)를 반환.

    실패 정책:
      - JWT_SECRET_KEY 미설정 → 503 (앱은 기동되지만 이 의존성만 비활성).
      - 쿠키 없음 / 만료 / 서명오류 / 디코드오류 / sub 변환 실패 → 모두 401.
        상세 사유는 로그에만 남기고 응답 본문에는 노출하지 않는다.
    """
    settings = get_settings()

    if not settings.jwt_secret_key:
        # 전역 크래시 금지: 키가 주입 안 된 환경에서도 앱 자체는 살아있어야 한다.
        logger.error(
            "JWT_SECRET_KEY 미설정 — accessToken 검증 불가. (env 주입 여부 확인 필요)"
        )
        raise HTTPException(
            status_code=503,
            detail={
                "code": "auth_unavailable",
                "message": "Authentication is temporarily unavailable.",
            },
        )

    token = request.cookies.get("accessToken")
    if not token:
        raise HTTPException(
            status_code=401,
            detail={"code": "missing_access_token", "message": "Authentication required."},
        )

    # algorithms 를 명시적으로 고정 — alg 혼동/none 공격 차단 (필수).
    try:
        payload = jwt.decode(
            token,
            settings.jwt_secret_key,
            algorithms=[settings.jwt_algorithm],
        )
    except jwt.ExpiredSignatureError:
        logger.info("accessToken 만료")
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_token", "message": "Authentication required."},
        )
    except jwt.InvalidTokenError as exc:
        # 서명오류/디코드오류/형식오류 등 모든 PyJWT 검증 실패의 상위 예외.
        logger.info("accessToken 검증 실패: %s", exc)
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_token", "message": "Authentication required."},
        )

    sub = payload.get("sub")
    try:
        return int(sub)
    except (TypeError, ValueError):
        logger.info("accessToken sub 정수 변환 실패: %r", sub)
        raise HTTPException(
            status_code=401,
            detail={"code": "invalid_token", "message": "Authentication required."},
        )