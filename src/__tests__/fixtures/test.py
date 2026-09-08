# Python fixture for symbol tests

import os
from typing import Optional


class AiConfig:
    """Configuration for the AI system.

    Manages runtime parameters and model selection.
    """

    def __init__(self, model_name: str):
        self.enabled = True
        self.model_name = model_name

    @staticmethod
    def from_env() -> "AiConfig":
        name = os.environ.get("AI_MODEL", "default")
        return AiConfig(name)

    def get_model_name(self) -> str:
        return self.model_name


def ai_turn_system(config: AiConfig, state: dict) -> dict:
    """Process one AI turn."""
    msg = "error: {expected}"
    # } this should not affect indent counting
    if config.enabled:
        state["score"] = state.get("score", 0) + 1
    return state


class GameState:
    def __init__(self):
        self.score = 0
        self.level = 1


from ai_config import AiConfig
import ai_config
