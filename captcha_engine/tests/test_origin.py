"""
Tests for app/api/deps.py :: _origin_matches + _is_console_self_origin
=====================================================================
origin 서브도메인 매칭(_origin_matches) + 관리 콘솔 자체 도메인 면제(_is_console_self_origin).
순수 함수 (DB/Redis 의존 없음) 만 테스트.
실행: python tests/test_origin.py   또는   python -m pytest tests/test_origin.py -v

주의: app.api.deps 는 fastapi/sqlalchemy 등을 모듈 로드시 import 한다.
      따라서 requirements.txt 가 설치된 앱 환경(컨테이너/CI/venv)에서 실행해야 한다.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.api.deps import _is_console_self_origin, _origin_matches


# (allowed, incoming, expected, label)
CASES = [
    # --- 계획서 필수 표 ---
    ("https://example.com", "https://example.com", True, "정확 일치"),
    ("https://example.com", "https://app.example.com", True, "서브도메인"),
    ("https://example.com", "https://www.example.com", True, "서브도메인(www)"),
    ("https://example.com", "https://evilexample.com", False, "유사도메인 함정"),
    ("https://example.com", "https://example.com.evil.com", False, "접미사 위장"),
    ("https://example.com", "http://example.com", False, "스킴 불일치(다운그레이드)"),
    ("http://localhost:5173", "http://localhost:5173", True, "포트 포함 정확"),
    ("https://agami-captcha.cloud", "https://agami-captcha.cloud", True, "기존 케이스 회귀"),
    # --- 추가 방어 케이스 ---
    ("https://example.com", "https://a.b.example.com", True, "다단계 서브도메인"),
    ("http://localhost:5173", "http://localhost:3000", True, "포트 무시(다른 포트 통과)"),
    ("https://EXAMPLE.com", "https://example.com", True, "hostname 대소문자 정규화"),
    ("https://app.example.com", "https://example.com", False, "역방향 불가(상위도메인)"),
    ("https://example.com", "https://notexample.com", False, "접두사 함정"),
    ("https://example.com", "", False, "빈 incoming"),
    ("", "https://example.com", False, "빈 allowed"),
    ("https://example.com", "null", False, "Origin: null"),
    # --- 수정 C: 사용자 등록 도메인 / 외부 도메인 (콘솔 면제와 대비) ---
    ("https://shop.com", "https://shop.com", True, "등록 자기 도메인"),
    ("https://shop.com", "https://app.shop.com", True, "등록 도메인 서브도메인"),
    ("https://shop.com", "https://evil.com", False, "외부 미등록 도메인"),
]


def test_origin_matches_table() -> None:
    for allowed, incoming, expected, label in CASES:
        got = _origin_matches(allowed, incoming)
        assert got is expected, (
            f"{label}: _origin_matches({allowed!r}, {incoming!r}) = {got}, expected {expected}"
        )


def test_exact_match_backward_compat() -> None:
    # 기존 정확일치 동작 보존 (가장 중요)
    assert _origin_matches("https://agami-captcha.cloud", "https://agami-captcha.cloud") is True
    assert _origin_matches("http://localhost:5173", "http://localhost:5173") is True


def test_subdomain_inclusion() -> None:
    assert _origin_matches("https://example.com", "https://app.example.com") is True
    assert _origin_matches("https://example.com", "https://www.example.com") is True


def test_lookalike_and_suffix_spoofing_rejected() -> None:
    assert _origin_matches("https://example.com", "https://evilexample.com") is False
    assert _origin_matches("https://example.com", "https://example.com.evil.com") is False


def test_scheme_downgrade_rejected() -> None:
    assert _origin_matches("https://example.com", "http://example.com") is False


# ===========================================================================
# 수정 C: 관리 콘솔 자체 도메인 면제 (_is_console_self_origin) — 순수 함수
# self_origin 은 config.console_self_origin (기본값 아래와 동일) 에서 주입된다.
# ===========================================================================
CONSOLE_SELF_ORIGIN = "https://agami-captcha.cloud"

# (origin, self_origin, expected, label)
SELF_ORIGIN_CASES = [
    ("https://agami-captcha.cloud", CONSOLE_SELF_ORIGIN, True, "콘솔 정확 일치 → 면제"),
    ("http://agami-captcha.cloud", CONSOLE_SELF_ORIGIN, False, "스킴 다름(http) → 면제 안 됨"),
    ("https://app.agami-captcha.cloud", CONSOLE_SELF_ORIGIN, False, "서브도메인 → 면제 안 됨"),
    ("https://evil.com", CONSOLE_SELF_ORIGIN, False, "외부 도메인 → 면제 안 됨"),
    ("https://agami-captcha.cloud.evil.com", CONSOLE_SELF_ORIGIN, False, "접미사 위장 → 면제 안 됨"),
    ("https://agami-captcha.cloud", "", False, "config 미설정 → 면제 없음(fail-safe)"),
]


def test_is_console_self_origin_table() -> None:
    for origin, self_origin, expected, label in SELF_ORIGIN_CASES:
        got = _is_console_self_origin(origin, self_origin)
        assert got is expected, (
            f"{label}: _is_console_self_origin({origin!r}, {self_origin!r}) = {got}, expected {expected}"
        )


def test_console_exemption_is_exact_only() -> None:
    # 면제는 정확히 https://agami-captcha.cloud 하나만 (와일드카드/서브도메인 금지)
    assert _is_console_self_origin("https://agami-captcha.cloud", CONSOLE_SELF_ORIGIN) is True
    assert _is_console_self_origin("https://x.agami-captcha.cloud", CONSOLE_SELF_ORIGIN) is False
    assert _is_console_self_origin("http://agami-captcha.cloud", CONSOLE_SELF_ORIGIN) is False


if __name__ == "__main__":
    test_origin_matches_table()
    test_exact_match_backward_compat()
    test_subdomain_inclusion()
    test_lookalike_and_suffix_spoofing_rejected()
    test_scheme_downgrade_rejected()
    test_is_console_self_origin_table()
    test_console_exemption_is_exact_only()
    print(
        f"OK — all origin tests passed "
        f"({len(CASES)} match cases + {len(SELF_ORIGIN_CASES)} console cases + 5 focused tests)"
    )
