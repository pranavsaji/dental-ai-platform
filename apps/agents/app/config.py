import os
from pathlib import Path

from dotenv import load_dotenv

# Root .env is three levels up from this file (apps/agents/app/config.py)
# Load the repo-root .env in local dev; in containers (shallower paths, env
# injected by the platform) there may be no .env anywhere — that's fine.
_env_file = next(
    (p / ".env" for p in Path(__file__).resolve().parents if (p / ".env").exists()),
    None,
)
if _env_file is not None:
    load_dotenv(_env_file)

# Provider priority: DeepSeek is primary; Anthropic is the fallback used only
# when DeepSeek is unconfigured or a DeepSeek call fails.
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_MODEL = os.getenv("AGENTS_DEEPSEEK_MODEL", "deepseek-chat")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.getenv("AGENTS_MODEL", "claude-opus-4-8")

# Kept for backward compatibility with callers that report the model name.
MODEL = DEEPSEEK_MODEL if DEEPSEEK_API_KEY else ANTHROPIC_MODEL

PLATFORM_DATABASE_URL = os.getenv(
    "PLATFORM_DATABASE_URL", "postgres://dental:dental@localhost:5442/dental"
)


def provider_chain() -> list[str]:
    """Providers in call order: deepseek first, anthropic as fallback."""
    chain = []
    if DEEPSEEK_API_KEY:
        chain.append("deepseek")
    if ANTHROPIC_API_KEY:
        chain.append("anthropic")
    return chain


def llm_available() -> bool:
    return bool(provider_chain())
