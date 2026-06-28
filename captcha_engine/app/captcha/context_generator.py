"""
감정 맥락 추론 캡챠 동적 생성기 (브리지)
==========================================
WBS 2.1.3 / context_inference 브리지: 1챌린지 = N개 문제 시퀀스.
콘텐츠·채점을 외부 "감정추론 채점 서비스"(context-emotion-api)에 위임한다.

발급 흐름
---------
1. 난이도별 문항 수(2/3/4)만큼 emotion ``/context-emotion/challenge`` 를 호출.
   (emotion 서비스는 난이도/로케일 인자가 없으므로 난이도는 호출 횟수로만 표현.)
2. 세션은 1챌린지당 1개(session_id)를 생성해 전 문항이 공유, attempt 에 재전송.
3. 이미지 URL 은 호스트 은닉을 위해 자기 도메인 프록시 경로
   ``/v1/context-image/{challenge_id}/{index}`` 로 재작성(원본 상대경로 전체는 answer 에 보관).
4. 정답은 spec/answer 어디에도 두지 않는다 — 채점은 context_client.grade → /attempt.

flashlight_generator / face_generator 와 동일한 (spec, answer) 페어 반환 패턴 유지.

이 모듈의 책임 경계
-------------------
- [O] N문항 발급(외부 호출), 만료 계산, (spec, answer) 페어 반환
- [X] 정답 검증              -> app/captcha/context_client.py:grade (/attempt)
- [X] 이미지 서빙            -> app/api/context_image.py (프록시)
- [X] Redis 저장 / API 응답  -> app/cache/challenge_store, app/api/public.py
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Final

from fastapi import HTTPException

from app.captcha import context_client
from app.captcha.challenge_types import (
    ChallengeKind,
    ContextChallengeAnswer,
    ContextChallengeSpec,
    ContextQuestion,
    ContextSubAnswer,
    Difficulty,
)


# ---------------------------------------------------------------------------
# 난이도 프로필
#   question_count : emotion /challenge 호출 횟수(=문항 수).
#   time_limit_sec / hint_after_sec : 전체 시간 압박(위젯 UX).
# ---------------------------------------------------------------------------

DIFFICULTY_PROFILES: Final[dict[Difficulty, dict]] = {
    Difficulty.EASY: {
        "question_count": 2,
        "time_limit_sec": 30,
        "hint_after_sec": 12,
    },
    Difficulty.MEDIUM: {
        "question_count": 3,
        "time_limit_sec": 30,
        "hint_after_sec": 12,
    },
    Difficulty.HARD: {
        "question_count": 4,
        "time_limit_sec": 30,
        "hint_after_sec": None,
    },
}


def _parse_iso(ts: str) -> datetime | None:
    """ISO8601 파싱. 'Z' 접미는 '+00:00' 으로 치환. 실패 시 None."""
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


async def _build_once(
    *,
    difficulty: Difficulty,
    now: datetime,
) -> tuple[ContextChallengeSpec, ContextChallengeAnswer]:
    """emotion 서비스를 N회 호출해 (spec, answer) 1세트를 구성. 발급 실패는 raise."""
    profile = DIFFICULTY_PROFILES[difficulty]
    count = profile["question_count"]

    challenge_id = secrets.token_urlsafe(16)
    session_id = secrets.token_urlsafe(24)  # 8~128 범위. 전 문항 공유.

    questions: list[ContextQuestion] = []
    sub_answers: list[ContextSubAnswer] = []
    emotion_expiries: list[datetime] = []

    for idx in range(count):
        data = await context_client.create_challenge(session_id)
        # v2: emotion 이 준 상대경로 전체를 파싱 없이 그대로 보관(서브디렉토리 유실 방지).
        image_path = str(data["image_url"])
        choices = [str(c) for c in data.get("choices", [])]
        questions.append(ContextQuestion(
            index=idx,
            image_url=f"/v1/context-image/{challenge_id}/{idx}",
            choices=choices,
        ))
        sub_answers.append(ContextSubAnswer(
            index=idx,
            emotion_challenge_id=str(data["challenge_id"]),
            image_path=image_path,
        ))
        parsed = _parse_iso(data["expires_at"]) if data.get("expires_at") else None
        if parsed is not None:
            emotion_expiries.append(parsed)

    # 만료: 프로필 기반과 emotion 가장 이른 만료 중 작은 값으로 캡한다
    # (emotion challenge 가 먼저 만료되면 attempt 가 410 → fail-closed miss 가 되므로).
    profile_expiry = now + timedelta(seconds=profile["time_limit_sec"] + 10)
    aware_candidates = [profile_expiry] + [e for e in emotion_expiries if e.tzinfo is not None]
    expires_at = min(aware_candidates)

    # emotion 이 이미 만료(또는 임박)된 expires_at 을 주면 save_answer 의 TTL 이 <=0 →
    # ValueError(500). 그런 챌린지는 신뢰할 수 없으므로 발급 자체를 실패로 보고
    # (ContextServiceUnavailable → 호출처가 1회 재시도 후 503 graceful).
    if expires_at <= now + timedelta(seconds=1):
        raise context_client.ContextServiceUnavailable(reason="challenge_expired")

    spec = ContextChallengeSpec(
        challenge_id=challenge_id,
        kind=ChallengeKind.CONTEXT_INFERENCE,
        difficulty=difficulty,
        issued_at=now,
        expires_at=expires_at,
        questions=questions,
        total_count=count,
        time_limit_sec=profile["time_limit_sec"],
        hint_after_sec=profile["hint_after_sec"],
    )

    answer = ContextChallengeAnswer(
        challenge_id=challenge_id,
        session_id=session_id,
        sub_answers=sub_answers,
        created_at=now,
        expires_at=expires_at,
    )

    return spec, answer


async def generate_context_challenge(
    difficulty: Difficulty = Difficulty.MEDIUM,
    *,
    now: datetime | None = None,
) -> tuple[ContextChallengeSpec, ContextChallengeAnswer]:
    """
    감정 맥락 추론 캡챠 1챌린지(=N문제 시퀀스) 생성 (외부 서비스 브리지).

    Returns
    -------
    (spec, answer)
        spec   : 클라이언트로 보낼 사양. questions(프록시 image_url + 보기). 정답 없음.
        answer : 서버 보관용 메타. session_id + 문항별 emotion challenge_id/파일명.

    Raises
    ------
    fastapi.HTTPException(503)
        emotion 서비스 발급이 1회 재시도 후에도 실패한 경우(fail-closed).
    """
    now = now or datetime.now(timezone.utc)
    try:
        return await _build_once(difficulty=difficulty, now=now)
    except context_client.ContextServiceUnavailable:
        # in-memory challenge 소비/일시 장애 흡수: 전체 발급을 1회 재시도.
        try:
            return await _build_once(difficulty=difficulty, now=datetime.now(timezone.utc))
        except context_client.ContextServiceUnavailable as e:
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "context_service_unavailable",
                    "message": "감정추론 채점 서비스에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.",
                },
            ) from e
