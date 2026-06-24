"""
Tests for app/api/deps.py :: _origin_matches (origin 서브도메인 매칭)
==================================================================
순수 함수 (DB/Redis 의존 없음) 만 테스트.
실행: python tests/test_origin.py   또는   python -m pytest tests/test_origin.py -v

주의: app.api.deps 는 fastapi/sqlalchemy 등을 모듈 로드시 import 한다.
      따라서 requirements.txt 가 설치된 앱 환경(컨테이너/CI/venv)에서 실행해야 한다.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.api.deps import _origin_matches


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


if __name__ == "__main__":
    test_origin_matches_table()
    test_exact_match_backward_compat()
    test_subdomain_inclusion()
    test_lookalike_and_suffix_spoofing_rejected()
    test_scheme_downgrade_rejected()
    print(f"OK — all origin tests passed ({len(CASES)} table cases + 4 focused tests)")
