"""
안면 미션 캡챠 동적 생성기
============================
WBS 2.1.2: 사용자가 카메라 앞에서 일련의 안면 동작을 수행하도록 지시.

설계 원칙
---------
1. flashlight_generator 와 동일한 인터페이스 패턴: (spec, answer) 튜플 반환,
   순수 함수, secrets.SystemRandom 사용.
2. 정답은 expected_instruction_types 만 보관. 실제 동작 자동 감지(MediaPipe)는
   팀원 합류 후 별도 모듈로 추가 → 본 단계는 클라이언트가 보고하는
   completed_instructions 를 그대로 비교하는 임시 로직으로 운영.
3. 지시 종류는 FaceInstructionType enum 의 모든 값 중 중복 없이 sample.

이 모듈의 책임 경계
-------------------
- [O] challenge_id 발급, 지시 종류/개수/시간 결정
- [O] (spec, answer) 페어 반환
- [X] 카메라 영상 분석          -> 팀원 MediaPipe 모듈 담당 (예정)
- [X] Redis 저장 / API 응답     -> WBS #43 의 challenge_store / public.py 담당
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Final

from app.captcha.challenge_types import (
    ChallengeKind,
    Difficulty,
    FaceChallengeAnswer,
    FaceChallengeSpec,
    FaceInstruction,
    FaceInstructionType,
    FACE_INSTRUCTION_LABELS,
    HandInstruction,
    HandInstructionType,
    HAND_INSTRUCTION_LABELS,
    FINGER_NAMES_KO,
)


# ---------------------------------------------------------------------------
# 난이도별 프로필
# ---------------------------------------------------------------------------

# hand_instruction_count: A3 손동작 지시 개수. face instruction_count(1/2/3) 와
# 평행. 현재 public.py 가 difficulty 를 EASY 로 하드코드하므로 실효값은 EASY(=1)
# 뿐이며, medium/hard 의 escalation 은 EASY 하드코드 해제 시 함께 의미를 갖는다.
DIFFICULTY_PROFILES: Final[dict[Difficulty, dict]] = {
    Difficulty.EASY: {
        "instruction_count": 1,
        "hand_instruction_count": 1,
        "duration_per_instruction_sec": 3,
        "time_limit_sec": 30,
        "hint_after_sec": 12,
        "tolerance_sec": 1.5,
    },
    Difficulty.MEDIUM: {
        "instruction_count": 2,
        "hand_instruction_count": 2,
        "duration_per_instruction_sec": 3,  # 사용자 사양 "각 동작 2.5초" → 정수 보존 위해 3
        "time_limit_sec": 25,
        "hint_after_sec": 10,
        "tolerance_sec": 1.0,
    },
    Difficulty.HARD: {
        "instruction_count": 3,
        "hand_instruction_count": 3,
        "duration_per_instruction_sec": 2,
        "time_limit_sec": 20,
        "hint_after_sec": None,
        "tolerance_sec": 0.8,
    },
}

# ---------------------------------------------------------------------------
# A3 손동작 발급 파라미터
# ---------------------------------------------------------------------------
# 각 hand 슬롯은 확률 FINGER_POSE_CHANCE 로 finger_pose(손가락 지정)를, 나머지는
# 제스처 3종(open/fist/pinch, 좌우 side 지정)을 발급한다. finger_pose 는 좌우 무관.
GESTURE_TYPES: Final[list[HandInstructionType]] = [
    HandInstructionType.OPEN_HAND,
    HandInstructionType.FIST,
    HandInstructionType.PINCH,
]
FINGER_POSE_CHANCE: Final[float] = 0.35  # hand 슬롯이 finger_pose 일 확률(나머지는 제스처)
# 발급 가능한 손가락 포즈. ★ 엄지 포함 포즈는 엄지 검출 불안정성 때문에 제외(검지/V 만).
FINGER_POSE_CATALOG: Final[list[list[str]]] = [
    ["index"],            # 검지만 펴기
    ["index", "middle"],  # 검지+중지(브이)
]


# ---------------------------------------------------------------------------
# 메인 생성 함수
# ---------------------------------------------------------------------------

def generate_face_challenge(
    difficulty: Difficulty = Difficulty.MEDIUM,
    *,
    rng: secrets.SystemRandom | None = None,
    now: datetime | None = None,
) -> tuple[FaceChallengeSpec, FaceChallengeAnswer]:
    """
    안면 미션 캡챠 1개 인스턴스를 생성한다.

    Returns
    -------
    (spec, answer)
        spec   : 클라이언트로 보낼 사양 (지시 목록 포함)
        answer : 서버 보관용 정답 (expected_instruction_types 만 보관)
    """
    rng = rng or secrets.SystemRandom()
    now = now or datetime.now(timezone.utc)
    profile = DIFFICULTY_PROFILES[difficulty]

    count: int = profile["instruction_count"]
    duration: int = profile["duration_per_instruction_sec"]

    # 지시 종류는 중복 없이 sample.
    instruction_pool = list(FaceInstructionType)
    if count > len(instruction_pool):
        raise ValueError(
            f"지시 카탈로그({len(instruction_pool)}) 보다 많은 지시({count})를 요청함."
        )
    chosen: list[FaceInstructionType] = rng.sample(instruction_pool, k=count)

    instructions = [
        FaceInstruction(
            type=t,
            label=FACE_INSTRUCTION_LABELS[t],
            duration_sec=duration,
        )
        for t in chosen
    ]

    # A3: 손동작 지시 생성. 각 슬롯은 확률적으로 (a) 기존 제스처 3종(open/fist/pinch,
    # 좌우 side 지정) 또는 (b) finger_pose(손가락 지정, 좌우 무관)를 발급한다.
    # ★ finger_pose 의 엄지 포함 미션은 엄지 검출 불안정성 때문에 이번엔 발급하지 않는다
    #   (FINGER_POSE_CATALOG 에 thumb 없음).
    hand_count: int = profile.get("hand_instruction_count", 0)
    hand_instructions: list[HandInstruction] = []
    for _ in range(hand_count):
        if rng.random() < FINGER_POSE_CHANCE:
            fingers = list(rng.choice(FINGER_POSE_CATALOG))
            label = " + ".join(FINGER_NAMES_KO[f] for f in fingers) + " 펴기"
            hand_instructions.append(
                HandInstruction(
                    type=HandInstructionType.FINGER_POSE,
                    label=label,
                    duration_sec=duration,
                    hand=None,  # finger_pose 는 좌우 무관(우선 독립)
                    fingers=fingers,
                )
            )
        else:
            t = rng.choice(GESTURE_TYPES)
            hand_instructions.append(
                HandInstruction(
                    type=t,
                    label=HAND_INSTRUCTION_LABELS[t],
                    duration_sec=duration,
                    hand=rng.choice(["left", "right"]),  # 제스처는 좌우 side 발급 ON
                )
            )

    challenge_id = secrets.token_urlsafe(16)
    expires_at = now + timedelta(seconds=profile["time_limit_sec"] + 10)

    spec = FaceChallengeSpec(
        challenge_id=challenge_id,
        kind=ChallengeKind.FACE_MISSION,
        difficulty=difficulty,
        issued_at=now,
        expires_at=expires_at,
        instructions=instructions,
        hand_instructions=hand_instructions,
        time_limit_sec=profile["time_limit_sec"],
        hint_after_sec=profile["hint_after_sec"],
    )

    answer = FaceChallengeAnswer(
        challenge_id=challenge_id,
        expected_instruction_types=[t.value for t in chosen],
        expected_hand_instruction_types=[hi.type for hi in hand_instructions],
        # 각 hand instruction 의 기대 손("left"/"right"). 위 hand=rng.choice 로 side 발급
        # ON 이라 HandInstruction.hand 에서 자동으로 흐른다. hand=None 이면 None 으로 흘러
        # 좌우 미검증(backcompat).
        expected_hand_sides=[hi.hand for hi in hand_instructions],
        # 각 hand instruction 의 펴야 할 손가락. 발급 OFF → 전부 None(손가락 무검증).
        # HandInstruction.fingers 를 채우면 자동 흐름(2b 발급 ON 단계).
        expected_fingers=[hi.fingers for hi in hand_instructions],
        tolerance_sec=profile["tolerance_sec"],
        created_at=now,
        expires_at=expires_at,
    )

    return spec, answer


# ---------------------------------------------------------------------------
# CLI 동작 확인
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import json

    for diff in Difficulty:
        spec, answer = generate_face_challenge(diff)
        print(f"=== {diff.value.upper()} ===")
        print("[client spec]")
        print(json.dumps(spec.model_dump(mode="json"), ensure_ascii=False, indent=2))
        print("[server answer]")
        print(json.dumps(answer.model_dump(mode="json"), ensure_ascii=False, indent=2))
        print()
