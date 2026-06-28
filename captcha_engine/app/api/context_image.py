"""
감정추론 이미지 프록시 (context_inference)
==========================================
감정추론 채점 서비스의 이미지(``/static/images/sample_*.jpg``)를 캡챠 엔진 자기
도메인 경로로 중계한다. emotion 서비스 호스트가 브라우저에 절대 노출되지 않도록
(위젯/회원사 은닉 요건) — 발급 시 image_url 이
``/v1/context-image/{challenge_id}/{index}`` 로 재작성되고, 이 라우트가 upstream 을
스트리밍 프록시한다.

보안
----
- ref(challenge_id + index)는 Redis answer 레코드(peek_answer, **비소비**)에서
  이미지 상대경로를 역참조한다 — 클라이언트가 임의 경로를 지정할 수 없다.
- 상대경로(v2: 서브디렉토리 포함)를 prefix(/static/images/)·".."·scheme/netloc·확장자로
  검증해 경로주입/SSRF 를 차단한다(파싱 없이 base_url 에 붙여 사용).
- 인증/Origin 의존성 없음: 정적 이미지처럼 cross-origin ``<img>`` GET 으로 로드됨.
  (challenge_id 는 추측 불가한 token_urlsafe 이고 발급은 rate-limit 됨.)
"""

from __future__ import annotations

import logging
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from app.api.deps import get_store
from app.cache.challenge_store import ChallengeStore
from app.captcha.challenge_types import ChallengeKind
from app.core.config import get_settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v1")

# 허용 이미지 확장자 + emotion 이미지 고정 prefix.
_ALLOWED_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp")
_REQUIRED_IMAGE_PREFIX = "/static/images/"


def _is_safe_image_path(path: str) -> bool:
    """저장된 emotion 이미지 상대경로(v2: 서브디렉토리 포함)가 안전한지 검증.

    base_url 이 emotion 으로 고정돼 있어도 httpx 의 base_url 병합은 참조 해석을 따르므로
    그대로 두면 다른 호스트/경로로 샐 수 있다(httpx 0.28 실측):
      - "http://evil/x"   : 절대 URL 이 base 를 덮어써 evil 로 나감     → scheme 거부
      - "/a/../../etc/x"  : ".." dot-segment 가 정규화돼 prefix 밖 탈출 → ".." 거부
      - "/etc/x", "//h/x" : /static/images/ 밖                          → prefix 거부
    아래 검증(scheme/netloc·"//"·prefix·".."·확장자)이면 emotion 의 /static/images/
    하위로만 고정된다.
    """
    if not path:
        return False
    # 외부 호스트/스킴 차단 (절대 URL·네트워크경로가 base 호스트를 덮어쓰는 것 방지).
    if path.startswith(("http:", "https:", "//")):
        return False
    parsed = urlparse(path)
    if parsed.scheme or parsed.netloc:
        return False
    # 경로 고정: 반드시 /static/images/ 하위.
    if not path.startswith(_REQUIRED_IMAGE_PREFIX):
        return False
    # path-traversal 차단 (httpx 가 ".." 를 정규화해 prefix 밖으로 빠질 수 있음).
    if ".." in path:
        return False
    # 확장자 화이트리스트.
    if not path.lower().endswith(_ALLOWED_IMAGE_EXT):
        return False
    return True


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={"code": "image_not_found", "message": "Image not found."},
    )


@router.get("/context-image/{challenge_id}/{index}")
async def context_image(
    challenge_id: str,
    index: int,
    store: ChallengeStore = Depends(get_store),
) -> StreamingResponse:
    """발급된 context_inference 챌린지의 index 번째 문제 이미지를 프록시 스트리밍."""
    ans = await store.peek_answer(challenge_id)
    if ans is None or ans.kind != ChallengeKind.CONTEXT_INFERENCE:
        raise _not_found()

    sub = next((s for s in ans.sub_answers if s.index == index), None)
    if sub is None:
        raise _not_found()

    path = sub.image_path
    if not _is_safe_image_path(path):
        logger.warning("context image rejected unsafe path: %r (cid=%s)", path, challenge_id)
        raise _not_found()

    settings = get_settings()
    # 수동 스트리밍: per-request AsyncClient 를 열고, 응답이 끝난 뒤 BackgroundTask 로
    # upstream 과 client 를 모두 닫는다. (FastAPI/httpx 공식 manual-streaming 패턴.)
    client = httpx.AsyncClient(
        base_url=settings.context_emotion_api_url,
        timeout=settings.context_emotion_timeout_sec,
    )
    try:
        # v2: 저장된 상대경로(서브디렉토리 포함)를 그대로 사용. base_url 은 emotion 으로
        # 고정 + 위 _is_safe_image_path 검증으로 다른 호스트/경로로 샐 수 없음.
        req = client.build_request("GET", path)
        upstream = await client.send(req, stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        logger.warning("context image upstream error: %r (cid=%s)", e, challenge_id)
        raise _not_found() from e

    if upstream.status_code != 200:
        await upstream.aclose()
        await client.aclose()
        raise _not_found()

    async def _close() -> None:
        await upstream.aclose()
        await client.aclose()

    return StreamingResponse(
        upstream.aiter_bytes(),
        status_code=200,
        media_type=upstream.headers.get("content-type", "image/jpeg"),
        background=BackgroundTask(_close),
    )
