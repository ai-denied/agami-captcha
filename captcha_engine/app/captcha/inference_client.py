"""
Flashlight Inference HTTP Client
================================
손전등 캡챠 봇 위험도 추론을 컨테이너 내부 ONNX 대신 같은 클러스터의
추론 마이크로서비스(``flashlight-inference-api-svc``) HTTP 호출로 수행한다.

옵션 A: ``/api/v1/predict`` 만 3회 호출하고, 최종 allow/block 판정은 기존
``flashlight_policy.evaluate_flashlight_decision`` (좌표 2/3 AND high_risk 0회)
이 그대로 담당한다. ``/api/v1/decide`` 는 사용하지 않는다.

장애 정책: **fail-closed**. 추론 API 503/타임아웃/연결실패/비200, 또는 빈
trajectory 면 :class:`InferenceUnavailable` 를 raise → 호출처(핸들러)가 해당
캡챠를 block 처리한다.

좌표 공간: 추론 모델은 800x600 픽셀 학습 분포를 기대한다. 위젯 캔버스 픽셀
좌표를 :func:`scale_trajectory_to_training` 로 800x600 으로 환산해 전송한다
(상수는 ``mlops_formatter`` 와 단일 출처 공유). 시간 t 는 feature extractor 가
차분(dt)만 사용하므로 변환 없이 그대로 보낸다.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from app.captcha.mlops_formatter import TRAINING_IMG_H, TRAINING_IMG_W
from app.core.config import get_settings

logger = logging.getLogger(__name__)

_PREDICT_PATH = "/api/v1/predict"

__all__ = [
    "InferenceUnavailable",
    "scale_trajectory_to_training",
    "predict_scores",
]


class InferenceUnavailable(Exception):
    """추론을 신뢰할 수 없어 fail-closed(block) 해야 할 때 raise.

    Attributes:
        reason: 차단 사유 라벨. ``empty_trajectory`` / ``missing_canvas_dims`` /
            ``inference_unavailable`` 중 하나. 핸들러 로그/attack_type 에 사용.
    """

    def __init__(self, reason: str = "inference_unavailable", message: str | None = None) -> None:
        self.reason = reason
        super().__init__(message or reason)


def scale_trajectory_to_training(
    trajectory: list[dict],
    canvas_width: int,
    canvas_height: int,
) -> list[dict]:
    """위젯 캔버스 픽셀 trajectory 를 800x600 학습 좌표계로 환산.

    ``mlops_formatter.to_training_sessions`` 와 동일한 스케일 식을 사용하되,
    학습 데이터 전용인 +50ms t-offset 은 적용하지 않는다(차분에서 상쇄됨).

    Args:
        trajectory: ``[{"x","y","t"}, ...]`` 캔버스 픽셀 좌표.
        canvas_width: 해당 submission 의 캔버스 가로 픽셀.
        canvas_height: 해당 submission 의 캔버스 세로 픽셀.

    Returns:
        800x600 픽셀로 환산된 ``[{"x","y","t"}, ...]``.
    """
    scale_x = TRAINING_IMG_W / canvas_width
    scale_y = TRAINING_IMG_H / canvas_height
    return [
        {
            "x": round(p["x"] * scale_x),
            "y": round(p["y"] * scale_y),
            "t": int(p["t"]),
        }
        for p in trajectory
        if isinstance(p, dict) and "x" in p and "y" in p and "t" in p
    ]


async def _predict_one(client: httpx.AsyncClient, trajectory: list[dict]) -> float:
    """단일 trajectory 의 bot_risk_score 를 추론 API 에서 받아온다."""
    if not trajectory:
        raise InferenceUnavailable(reason="empty_trajectory")

    payload: dict[str, Any] = {
        "trajectory": trajectory,
        "coordinate_mode": "pixel",
        "canvas_width": TRAINING_IMG_W,
        "canvas_height": TRAINING_IMG_H,
    }
    resp = await client.post(_PREDICT_PATH, json=payload)
    resp.raise_for_status()  # 비200 → httpx.HTTPStatusError
    data = resp.json()
    score = data.get("bot_risk_score")
    if score is None:
        raise InferenceUnavailable(reason="inference_unavailable")
    return float(score)


async def predict_scores(trajectories: list[list[dict]]) -> list[float]:
    """3개(=N개) trajectory 의 bot_risk_score 를 동시에 추론한다.

    하나라도 실패(예외/비200/빈 trajectory)하면 :class:`InferenceUnavailable`
    를 raise 한다(fail-closed).

    Args:
        trajectories: 이미 800x600 으로 환산된 trajectory 리스트.

    Returns:
        입력 순서와 동일한 bot_risk_score(float) 리스트.

    Raises:
        InferenceUnavailable: 추론 API 장애/비정상 응답/빈 입력 시.
    """
    settings = get_settings()
    async with httpx.AsyncClient(
        base_url=settings.inference_api_url,
        timeout=settings.inference_timeout_sec,
    ) as client:
        results = await asyncio.gather(
            *(_predict_one(client, traj) for traj in trajectories),
            return_exceptions=True,
        )

    scores: list[float] = []
    for r in results:
        if isinstance(r, InferenceUnavailable):
            raise r
        if isinstance(r, BaseException):
            logger.warning("flashlight inference request failed: %r", r)
            raise InferenceUnavailable(reason="inference_unavailable") from r
        scores.append(r)
    return scores
