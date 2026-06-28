"""
Captcha Verifier
=================
WBS #43: 사용자 클릭이 정답 좌표 안에 들어왔는지 판정.

순수 함수만 모아둠. DB/Redis 의존 0 → 단위 테스트 쉬움.
AI 모델 (#44) 가 들어오면 confidence 보정만 추가하면 됨.
"""

from __future__ import annotations

import math

from app.captcha.challenge_types import (
    FaceChallengeAnswer,
    FlashlightSubAnswer,
)


_BBOX_MARGIN_NORM = 0.02  # 사용자가 약간 빗나가도 인정해주는 bbox 여유 (정규화).


def check_flashlight_hit(
    answer: FlashlightSubAnswer,
    click_x: float,
    click_y: float,
) -> bool:
    """
    클릭 좌표가 정답 안에 있으면 True. 좌표는 0~1 비율.

    bbox_w/bbox_h 가 둘 다 0보다 크면 bbox 사각형 매칭 (작은 margin 포함),
    그렇지 않으면 tolerance 기반 원형 매칭으로 fallback.

    1챌린지=3장 구조에서 sub-answer 단위로 호출됨.
    """
    if answer.bbox_w > 0 and answer.bbox_h > 0:
        half_w = answer.bbox_w / 2
        half_h = answer.bbox_h / 2
        x_min = answer.correct_x - half_w - _BBOX_MARGIN_NORM
        x_max = answer.correct_x + half_w + _BBOX_MARGIN_NORM
        y_min = answer.correct_y - half_h - _BBOX_MARGIN_NORM
        y_max = answer.correct_y + half_h + _BBOX_MARGIN_NORM
        return x_min <= click_x <= x_max and y_min <= click_y <= y_max

    distance = math.hypot(click_x - answer.correct_x, click_y - answer.correct_y)
    return distance <= answer.tolerance


def check_face_hit(
    answer: FaceChallengeAnswer,
    completed_instructions: list[str] | None,
) -> bool:
    """
    임시 검증: 클라이언트가 보고한 completed_instructions 가
    expected_instruction_types 와 정확히 같은 순서/내용이면 True.

    팀원 MediaPipe 합류 후 이 함수를 score_face_with_ai_model() 로 교체.
    교체 시그니처 예시:
        def score_face_with_ai_model(
            answer: FaceChallengeAnswer,
            face_behavioral_data: dict,
        ) -> tuple[Literal["human", "bot", "uncertain"], float]: ...
    """
    if not completed_instructions:
        return False
    return list(completed_instructions) == list(answer.expected_instruction_types)


def baseline_verdict(hit: bool) -> tuple[str, float]:
    """
    AI 모델 없이 임시로 사용할 verdict.
    - hit  → human, confidence 0.5
    - miss → bot,   confidence 0.5

    낮은 confidence 는 "행동 분석을 안 거친 단순 좌표 매칭" 임을 의미.
    #44 가 들어오면 이 함수를 대체할 score_with_ai_model() 로 교체.
    """
    if hit:
        return "human", 0.5
    return "bot", 0.5
