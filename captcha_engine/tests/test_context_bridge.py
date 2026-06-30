"""
context_inference ↔ 감정추론 서비스 브리지 단위 테스트
=====================================================
순수/모킹 가능한 로직만 검증 (DB/Redis/실네트워크 없음):
- context_client.grade : N문항 집계 / fail-closed
- context_client.attempt / create_challenge : httpx MockTransport 매핑
- ContextChallengeAnswer Redis 직렬화 round-trip + kind 디스패치
- generate_context_challenge(async) : create_challenge 모킹 → 구조 검증
- context_image 파일명 화이트리스트(SSRF/traversal 차단)

비동기 함수는 asyncio.run() 으로 감싸 sync 테스트로 실행(plugin 의존 없음).
httpx 호출은 httpx.MockTransport 로 가로채 실네트워크 0.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from unittest import mock

import httpx

from app.captcha import context_client, context_generator
from app.captcha.challenge_types import (
    ChallengeKind,
    ContextChallengeAnswer,
    ContextSubAnswer,
    Difficulty,
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _mk_answer(n: int = 2) -> ContextChallengeAnswer:
    now = datetime.now(timezone.utc)
    return ContextChallengeAnswer(
        challenge_id="cid_test",
        session_id="sess_test",
        sub_answers=[
            ContextSubAnswer(index=i, emotion_challenge_id=f"e{i}", image_path=f"/static/images/sample_{i}.jpg")
            for i in range(n)
        ],
        created_at=now,
        expires_at=now + timedelta(seconds=40),
    )


# 패치 전 진짜 AsyncClient 를 캡처 (factory 안에서 httpx.AsyncClient 를 쓰면
# 패치된 자기 자신을 호출해 무한재귀가 되므로 원본을 보존해 사용한다).
_REAL_ASYNC_CLIENT = httpx.AsyncClient


def _client_factory(handler):
    """httpx.AsyncClient 를 MockTransport 로 갈아끼우는 factory (실네트워크 차단)."""
    def _make(*args, **kwargs):
        return _REAL_ASYNC_CLIENT(
            transport=httpx.MockTransport(handler),
            base_url=kwargs.get("base_url", "http://test"),
            timeout=kwargs.get("timeout"),
        )
    return _make


# ---------------------------------------------------------------------------
# grade : 점수 합산(sum(score) >= 2.5) + fail-closed  (3문항, max 3.0)
# ---------------------------------------------------------------------------

def _attempt_by_label(score_map: dict, default: float = 0.0):
    """라벨 → score 매핑으로 attempt 를 모킹하는 async 함수."""
    async def fake_attempt(session_id, ecid, label, ms):
        return score_map.get(label, default)
    return fake_attempt


def test_grade_sum_at_threshold_is_hit():
    # 1.0 + 1.0 + 0.5 = 2.5 >= 2.5 → 통과 (부분점수 포함 경계)
    answer = _mk_answer(3)
    with mock.patch.object(context_client, "attempt",
                           _attempt_by_label({"a": 1.0, "b": 1.0, "c": 0.5})):
        assert asyncio.run(context_client.grade(answer, ["a", "b", "c"], 100)) is True


def test_grade_all_correct_is_hit():
    # 1.0 * 3 = 3.0 → 통과
    answer = _mk_answer(3)
    with mock.patch.object(context_client, "attempt",
                           _attempt_by_label({"a": 1.0, "b": 1.0, "c": 1.0})):
        assert asyncio.run(context_client.grade(answer, ["a", "b", "c"], 100)) is True


def test_grade_two_correct_below_threshold_is_miss():
    # 1.0 + 1.0 + 0.0 = 2.0 < 2.5 → 실패 (2문항 정답으론 부족)
    answer = _mk_answer(3)
    with mock.patch.object(context_client, "attempt",
                           _attempt_by_label({"a": 1.0, "b": 1.0, "c": 0.0})):
        assert asyncio.run(context_client.grade(answer, ["a", "b", "c"], 100)) is False


def test_grade_partials_below_threshold_is_miss():
    # 1.0 + 0.5 + 0.5 = 2.0 < 2.5 → 실패
    answer = _mk_answer(3)
    with mock.patch.object(context_client, "attempt",
                           _attempt_by_label({"a": 1.0, "b": 0.5, "c": 0.5})):
        assert asyncio.run(context_client.grade(answer, ["a", "b", "c"], 100)) is False


def test_grade_length_mismatch_is_miss():
    answer = _mk_answer(3)

    async def boom(*a, **k):  # must NOT be called
        raise AssertionError("attempt should not run on length mismatch")

    with mock.patch.object(context_client, "attempt", boom):
        assert asyncio.run(context_client.grade(answer, ["only_one"], 100)) is False


def test_grade_none_submitted_is_miss():
    answer = _mk_answer(3)
    assert asyncio.run(context_client.grade(answer, None, 100)) is False


def test_grade_attempt_exception_fails_closed():
    # 한 문항 예외 → 0.0 흡수. 나머지 1.0+1.0=2.0 < 2.5 → 실패
    answer = _mk_answer(3)

    async def fake_attempt(session_id, ecid, label, ms):
        if label == "boom":
            raise RuntimeError("upstream blew up")
        return 1.0

    with mock.patch.object(context_client, "attempt", fake_attempt):
        assert asyncio.run(context_client.grade(answer, ["x", "y", "boom"], 100)) is False


# ---------------------------------------------------------------------------
# attempt : score 매핑 + 하위호환(fallback) + fail-closed
# ---------------------------------------------------------------------------

def test_attempt_returns_score_field():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/context-emotion/attempt"
        body = json.loads(request.content)
        assert body["session_id"] == "s" and body["challenge_id"] == "e" and body["selected_label"] == "ok"
        return httpx.Response(200, json={"is_correct": True, "retry_allowed": False, "score": 1.0})

    with mock.patch("httpx.AsyncClient", _client_factory(handler)):
        assert asyncio.run(context_client.attempt("s", "e", "ok", 100)) == 1.0


def test_attempt_partial_score_half():
    # 동일 감정그룹 → 0.5 (is_correct=False 여도 score 우선)
    def handler(request):
        return httpx.Response(200, json={"is_correct": False, "retry_allowed": True, "score": 0.5})

    with mock.patch("httpx.AsyncClient", _client_factory(handler)):
        assert asyncio.run(context_client.attempt("s", "e", "x", 100)) == 0.5


def test_attempt_zero_score():
    def handler(request):
        return httpx.Response(200, json={"is_correct": False, "retry_allowed": True, "score": 0.0})

    with mock.patch("httpx.AsyncClient", _client_factory(handler)):
        assert asyncio.run(context_client.attempt("s", "e", "x", 100)) == 0.0


def test_attempt_score_clamped_to_unit():
    def handler(request):
        return httpx.Response(200, json={"score": 9.0})  # 비정상값 → [0,1] 클램프

    with mock.patch("httpx.AsyncClient", _client_factory(handler)):
        assert asyncio.run(context_client.attempt("s", "e", "x", 100)) == 1.0


def test_attempt_fallback_is_correct_true_when_score_absent():
    # score 미수신(지수님 배포 전) + is_correct=true → 1.0 환산
    def handler(request):
        return httpx.Response(200, json={"is_correct": True, "retry_allowed": False})

    with mock.patch("httpx.AsyncClient", _client_factory(handler)):
        assert asyncio.run(context_client.attempt("s", "e", "ok", 100)) == 1.0


def test_attempt_fallback_is_correct_false_when_score_absent():
    def handler(request):
        return httpx.Response(200, json={"is_correct": False, "retry_allowed": True})

    with mock.patch("httpx.AsyncClient", _client_factory(handler)):
        assert asyncio.run(context_client.attempt("s", "e", "x", 100)) == 0.0


def test_attempt_http_500_fails_closed():
    def handler(request):
        return httpx.Response(500, json={"detail": "boom"})

    with mock.patch("httpx.AsyncClient", _client_factory(handler)):
        assert asyncio.run(context_client.attempt("s", "e", "x", 100)) == 0.0


def test_attempt_410_fails_closed():
    def handler(request):
        return httpx.Response(410, json={"detail": "expired"})

    with mock.patch("httpx.AsyncClient", _client_factory(handler)):
        assert asyncio.run(context_client.attempt("s", "e", "x", 100)) == 0.0


def test_attempt_connect_error_fails_closed():
    def handler(request):
        raise httpx.ConnectError("refused")

    with mock.patch("httpx.AsyncClient", _client_factory(handler)):
        assert asyncio.run(context_client.attempt("s", "e", "x", 100)) == 0.0


# ---------------------------------------------------------------------------
# create_challenge : 매핑 + 오류 → ContextServiceUnavailable
# ---------------------------------------------------------------------------

def test_create_challenge_ok():
    def handler(request):
        assert request.url.path == "/context-emotion/challenge"
        return httpx.Response(200, json={
            "challenge_id": "ec1",
            "image_url": "/static/images/sample_42.jpg",
            "choices": ["happiness", "calm", "anger", "fear"],
            "expires_at": "2099-01-01T00:00:00+00:00",
        })

    with mock.patch("httpx.AsyncClient", _client_factory(handler)):
        data = asyncio.run(context_client.create_challenge("sess"))
    assert data["challenge_id"] == "ec1"
    assert data["choices"] == ["happiness", "calm", "anger", "fear"]


def test_create_challenge_http_error_raises_unavailable():
    def handler(request):
        return httpx.Response(503)

    with mock.patch("httpx.AsyncClient", _client_factory(handler)):
        try:
            asyncio.run(context_client.create_challenge("sess"))
            assert False, "expected ContextServiceUnavailable"
        except context_client.ContextServiceUnavailable as e:
            assert e.reason == "challenge_unavailable"


def test_create_challenge_malformed_raises_unavailable():
    def handler(request):
        return httpx.Response(200, json={"image_url": "/static/images/x.jpg"})  # no challenge_id

    with mock.patch("httpx.AsyncClient", _client_factory(handler)):
        try:
            asyncio.run(context_client.create_challenge("sess"))
            assert False, "expected ContextServiceUnavailable"
        except context_client.ContextServiceUnavailable as e:
            assert e.reason == "challenge_malformed"


# ---------------------------------------------------------------------------
# ContextChallengeAnswer Redis round-trip + kind 디스패치
# ---------------------------------------------------------------------------

def test_answer_redis_roundtrip_and_kind_dispatch():
    answer = _mk_answer(3)
    raw = answer.model_dump_json()                 # save_answer 가 쓰는 직렬화
    data = json.loads(raw)                          # consume/peek_answer 가 읽는 경로
    assert data["kind"] == ChallengeKind.CONTEXT_INFERENCE.value
    restored = ContextChallengeAnswer.model_validate(data)
    assert restored.challenge_id == answer.challenge_id
    assert restored.session_id == "sess_test"
    assert [s.image_path for s in restored.sub_answers] == [
        "/static/images/sample_0.jpg", "/static/images/sample_1.jpg", "/static/images/sample_2.jpg"
    ]
    assert [s.emotion_challenge_id for s in restored.sub_answers] == ["e0", "e1", "e2"]


# ---------------------------------------------------------------------------
# generate_context_challenge (async) : 구조 검증 (create_challenge 모킹)
# ---------------------------------------------------------------------------

def test_generate_context_challenge_structure_per_difficulty():
    canned = {
        "challenge_id": "ecX",
        "image_url": "/static/images/emotic/framesdb/framesdb/images/frame_7.jpg",  # v2 서브디렉토리
        "choices": ["happiness", "calm", "anger", "fear"],
        "expires_at": "2099-01-01T00:00:00+00:00",
    }
    now = datetime(2026, 6, 28, 12, 0, 0, tzinfo=timezone.utc)

    for diff in (Difficulty.EASY, Difficulty.MEDIUM, Difficulty.HARD):
        expected_count = context_generator.DIFFICULTY_PROFILES[diff]["question_count"]
        with mock.patch.object(
            context_client, "create_challenge",
            new=mock.AsyncMock(return_value=dict(canned)),
        ):
            spec, answer = asyncio.run(
                context_generator.generate_context_challenge(diff, now=now)
            )
        assert spec.kind == ChallengeKind.CONTEXT_INFERENCE
        assert spec.total_count == expected_count
        assert len(spec.questions) == expected_count
        assert len(answer.sub_answers) == expected_count
        assert answer.session_id  # truthy, generated
        for i, q in enumerate(spec.questions):
            # C1: 프록시 경로로 재작성, emotion 절대경로/호스트 노출 없음
            assert q.image_url == f"/v1/context-image/{spec.challenge_id}/{i}"
            assert q.choices == ["happiness", "calm", "anger", "fear"]
            assert all(isinstance(c, str) for c in q.choices)
        for i, sub in enumerate(answer.sub_answers):
            assert sub.index == i
            assert sub.emotion_challenge_id == "ecX"
            # v2: 서브디렉토리 포함 상대경로 전체를 파싱 없이 보관
            assert sub.image_path == "/static/images/emotic/framesdb/framesdb/images/frame_7.jpg"
        # emotion 만료가 더 미래 → 프로필 기반 만료(now+limit+10)가 채택
        assert spec.expires_at <= datetime(2099, 1, 1, tzinfo=timezone.utc)


def test_generate_context_challenge_retries_once_then_503():
    from fastapi import HTTPException

    call_count = {"n": 0}

    async def always_fail(session_id):
        call_count["n"] += 1
        raise context_client.ContextServiceUnavailable(reason="challenge_unavailable")

    with mock.patch.object(context_client, "create_challenge", always_fail):
        try:
            asyncio.run(context_generator.generate_context_challenge(Difficulty.EASY))
            assert False, "expected HTTPException(503)"
        except HTTPException as e:
            assert e.status_code == 503
            assert e.detail["code"] == "context_service_unavailable"
    # 최초 시도 + 1회 재시도 → create_challenge 가 최소 2번은 불렸다(각 시도 첫 문항에서 실패)
    assert call_count["n"] >= 2


def test_generate_past_expiry_raises_503_not_500():
    """emotion 이 이미 만료된 expires_at 을 주면 save_answer ValueError(500) 대신
    발급 실패로 보고(재시도 후 503)."""
    from fastapi import HTTPException

    past = {
        "challenge_id": "ecP",
        "image_url": "/static/images/sample_1.jpg",
        "choices": ["happiness", "calm", "anger", "fear"],
        "expires_at": "2000-01-01T00:00:00+00:00",  # 과거
    }
    with mock.patch.object(
        context_client, "create_challenge",
        new=mock.AsyncMock(return_value=dict(past)),
    ):
        try:
            asyncio.run(context_generator.generate_context_challenge(Difficulty.EASY))
            assert False, "expected HTTPException(503)"
        except HTTPException as e:
            assert e.status_code == 503


# ---------------------------------------------------------------------------
# context_image : 안전 상대경로 검증 (v2 서브디렉토리; SSRF / path-traversal 차단)
# ---------------------------------------------------------------------------

def test_image_path_guard():
    from app.api.context_image import _is_safe_image_path

    # 정상: v2 서브디렉토리 포함 상대경로 + 단순 경로
    assert _is_safe_image_path("/static/images/emotic/framesdb/framesdb/images/frame_X.jpg")
    assert _is_safe_image_path("/static/images/frame_1.png")
    assert _is_safe_image_path("/static/images/a/b/c.webp")
    # path-traversal (httpx 가 ".." 를 정규화해 prefix 밖으로 탈출 → 반드시 거부)
    assert not _is_safe_image_path("/static/images/../../etc/passwd")
    # 외부 호스트 (절대 URL 이 base 를 덮어씀 / 프로토콜-상대)
    assert not _is_safe_image_path("http://evil.com/x.jpg")
    assert not _is_safe_image_path("https://evil.com/x.jpg")
    assert not _is_safe_image_path("//evil.com/x.jpg")
    # prefix 위반 (/static/images/ 밖)
    assert not _is_safe_image_path("/etc/passwd")
    assert not _is_safe_image_path("/static/other/x.jpg")
    # 확장자 위반
    assert not _is_safe_image_path("/static/images/x.txt")
    assert not _is_safe_image_path("/static/images/x")
    # 빈 값
    assert not _is_safe_image_path("")


def test_context_image_route_streams_full_subpath():
    """정상 v2 서브경로 → 가드 통과 + upstream GET 이 emotion host 의 전체 서브경로로 나감."""
    from app.api import context_image as ci

    subpath = "/static/images/emotic/framesdb/framesdb/images/frame_9.jpg"
    now = datetime.now(timezone.utc)
    answer = ContextChallengeAnswer(
        challenge_id="cidR", session_id="s",
        sub_answers=[ContextSubAnswer(index=0, emotion_challenge_id="e0", image_path=subpath)],
        created_at=now, expires_at=now + timedelta(seconds=40),
    )
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["path"] = request.url.path
        captured["host"] = request.url.host
        return httpx.Response(200, content=b"IMGBYTES", headers={"content-type": "image/jpeg"})

    store = mock.Mock()
    store.peek_answer = mock.AsyncMock(return_value=answer)

    async def _run():
        with mock.patch("httpx.AsyncClient", _client_factory(handler)):
            resp = await ci.context_image("cidR", 0, store=store)
            body = b"".join([c async for c in resp.body_iterator])
            if resp.background is not None:
                await resp.background()
            return resp, body

    resp, body = asyncio.run(_run())
    assert captured["path"] == subpath          # 서브디렉토리 유실 없이 그대로
    assert captured["host"] == "context-emotion-api"  # 다른 호스트로 안 샘
    assert resp.status_code == 200
    assert resp.media_type == "image/jpeg"
    assert body == b"IMGBYTES"


def test_context_image_route_rejects_traversal_before_request():
    """traversal 경로면 upstream 호출 전에 404 (가드가 먼저 차단)."""
    from fastapi import HTTPException
    from app.api import context_image as ci

    now = datetime.now(timezone.utc)
    answer = ContextChallengeAnswer(
        challenge_id="cidR", session_id="s",
        sub_answers=[ContextSubAnswer(
            index=0, emotion_challenge_id="e0",
            image_path="/static/images/../../etc/passwd",
        )],
        created_at=now, expires_at=now + timedelta(seconds=40),
    )
    called = {"upstream": False}

    def handler(request):
        called["upstream"] = True
        return httpx.Response(200, content=b"x")

    store = mock.Mock()
    store.peek_answer = mock.AsyncMock(return_value=answer)

    async def _run():
        with mock.patch("httpx.AsyncClient", _client_factory(handler)):
            return await ci.context_image("cidR", 0, store=store)

    try:
        asyncio.run(_run())
        assert False, "expected HTTPException(404)"
    except HTTPException as e:
        assert e.status_code == 404
    assert called["upstream"] is False  # 가드가 upstream 호출 전에 차단
