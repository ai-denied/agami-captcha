"""
Context-Emotion Inference HTTP Client
=====================================
감정 맥락 추론(context_inference) 캡챠를 외부 "감정추론 채점 서비스"
(context-emotion-api, :8083)에 위임하는 비동기 HTTP 클라이언트.

captcha-api(엔진)가 중간 브리지가 되어 위젯의 기존 경로를 유지한 채 내부에서만
이 서비스를 호출한다. 위젯/회원사에는 이 서비스의 존재가 노출되지 않는다
(이미지는 app/api/context_image.py 프록시로 은닉).

엔드포인트 (LOCKED, openapi 실측)
---------------------------------
- POST /context-emotion/challenge  {session_id}
    -> {challenge_id, image_url(상대경로), choices[4], expires_at}
- POST /context-emotion/attempt    {session_id, challenge_id, selected_label, solve_time_ms}
    -> {is_correct, retry_allowed, score}   (토큰 없음. score: 1.0 정답/0.5 동일그룹/0.0 오답)
session_id 는 challenge 발급 때 쓴 값을 attempt 에 그대로 재전송해야 매칭된다.

장애 정책
---------
- 발급(create_challenge): 실패 시 ContextServiceUnavailable raise → 호출처가 1회
  재시도 후 503. (챌린지 자체를 못 만들면 발급 실패.)
- 채점(attempt): 문항 score(0.0~1.0) 반환. 실패(HTTPError/410/timeout/연결) 시 0.0,
  **절대 raise 안 함** → grade 가 sum(score)>=2.5 로 판정(fail-closed: 실패=0.0 감점).

구조 차용: app/captcha/inference_client.py 의 httpx.AsyncClient + base_url +
raise_for_status 패턴을 그대로 따른다.
"""

from __future__ import annotations

import asyncio
import logging

import httpx

from app.core.config import get_settings

logger = logging.getLogger(__name__)

_CHALLENGE_PATH = "/context-emotion/challenge"
_ATTEMPT_PATH = "/context-emotion/attempt"

# 통과 임계: 3문항(각 score max 1.0 → max 3.0) 누적 합계 기준. Phase1 발급 문항수
# (context_generator.DIFFICULTY_PROFILES) 변경 시 이 값도 동반 조정.
_PASS_THRESHOLD = 2.5

__all__ = [
    "ContextServiceUnavailable",
    "create_challenge",
    "attempt",
    "grade",
]


class ContextServiceUnavailable(Exception):
    """감정추론 채점 서비스를 신뢰할 수 없어 발급을 fail-closed 해야 할 때 raise.

    Attributes:
        reason: 사유 라벨(``challenge_unavailable`` / ``challenge_malformed``). 로그용.
    """

    def __init__(self, reason: str = "context_unavailable", message: str | None = None) -> None:
        self.reason = reason
        super().__init__(message or reason)


async def create_challenge(session_id: str) -> dict:
    """emotion 서비스에서 단일 문제(이미지 1장 + 보기 4개)를 발급받는다.

    Returns:
        raw json dict: ``{"challenge_id","image_url","choices","expires_at"}``.

    Raises:
        ContextServiceUnavailable: HTTP 오류/타임아웃/연결 실패/응답 누락 시.
    """
    settings = get_settings()
    try:
        async with httpx.AsyncClient(
            base_url=settings.context_emotion_api_url,
            timeout=settings.context_emotion_timeout_sec,
        ) as client:
            resp = await client.post(_CHALLENGE_PATH, json={"session_id": session_id})
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        logger.warning("context-emotion challenge request failed: %r", e)
        raise ContextServiceUnavailable(reason="challenge_unavailable") from e
    if not isinstance(data, dict) or "challenge_id" not in data or "image_url" not in data:
        raise ContextServiceUnavailable(reason="challenge_malformed")
    return data


async def attempt(
    session_id: str,
    emotion_challenge_id: str,
    selected_label: str,
    solve_time_ms: int,
) -> float:
    """emotion 서비스에 단일 문제 정답을 제출하고 문항 score(0.0~1.0)를 받는다.

    score: 1.0 정답 / 0.5 동일 감정그룹 / 0.0 오답 (서버 내부 판정).
    하위호환: 응답에 score 가 없으면 is_correct 로 환산(true→1.0 / false→0.0,
    0.5 부분점수 없음 — 지수님 score 배포 후 자동 활성화).
    fail-closed: 어떤 실패(HTTPError/410/timeout/응답 누락)든 0.0 을 반환하며
    **예외를 전파하지 않는다** (호출처 grade 가 sum>=2.5 로 판정).
    """
    settings = get_settings()
    try:
        async with httpx.AsyncClient(
            base_url=settings.context_emotion_api_url,
            timeout=settings.context_emotion_timeout_sec,
        ) as client:
            resp = await client.post(
                _ATTEMPT_PATH,
                json={
                    "session_id": session_id,
                    "challenge_id": emotion_challenge_id,
                    "selected_label": selected_label,
                    "solve_time_ms": solve_time_ms,
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPError as e:
        logger.warning("context-emotion attempt request failed (fail-closed=0.0): %r", e)
        return 0.0
    if not isinstance(data, dict):
        return 0.0
    raw = data.get("score")
    if raw is not None:
        try:
            return max(0.0, min(1.0, float(raw)))
        except (TypeError, ValueError):
            pass
    # score 미수신/파싱불가 → is_correct 환산(부분점수 없음; score 배포 후 자동 활성화)
    return 1.0 if data.get("is_correct") else 0.0


async def grade(answer, submitted_answers: list[str] | None, solve_time_ms: int) -> bool:
    """N문항 시퀀스를 emotion 서비스로 채점. 문항 score 합계 >= 임계(2.5)면 hit.

    answer.sub_answers 각 문항에 attempt 를 동시 호출해 score 를 받고 sum 으로 합산한다.
    길이 불일치/None → False. gather 예외/실패 문항은 0.0 으로 흡수(fail-closed).
    """
    if submitted_answers is None:
        return False
    subs = sorted(answer.sub_answers, key=lambda s: s.index)
    if len(submitted_answers) != len(subs):
        return False
    # subs(index 오름차순)와 submitted_answers(출제 순서)를 zip 으로 정렬 매칭.
    # 길이는 위에서 일치 확인됨 → 비연속 index 에도 IndexError 없이 안전.
    results = await asyncio.gather(
        *(
            attempt(
                answer.session_id,
                sub.emotion_challenge_id,
                selected,
                solve_time_ms,
            )
            for sub, selected in zip(subs, submitted_answers)
        ),
        return_exceptions=True,
    )
    # attempt 는 0.0~1.0 score. gather 예외/비수치는 0.0 으로 흡수(fail-closed).
    scores = [
        float(r) if isinstance(r, (int, float)) and not isinstance(r, bool) else 0.0
        for r in results
    ]
    return sum(scores) >= _PASS_THRESHOLD
