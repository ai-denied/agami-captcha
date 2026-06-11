"""
로그인 사용자 전용 라우트
=========================
agamidb 가 발급한 accessToken(JWT, HS256) 쿠키로 인증되는 라우트 모음.

기존 client_key 기반 public 라우터(app/api/public.py)와 분리된 별도 라우터.
main.py 에서 prefix="/captcha" 로 등록되어 내부 prefix("/v1")와 합쳐져
최종 /captcha/v1/* 경로로 노출된다 (public_router 와 동일한 규약).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_current_user_id

router = APIRouter(prefix="/v1", tags=["user"])


@router.get("/whoami")
async def whoami(current_user_id: int = Depends(get_current_user_id)) -> dict:
    """accessToken 쿠키 검증이 통과한 사용자의 id 를 반환.

    JWT 의존성 동작 확인 전용 엔드포인트. 최종 경로: GET /captcha/v1/whoami.
    """
    return {"user_id": current_user_id}
