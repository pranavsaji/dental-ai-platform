"""Provider-agnostic structured LLM invocation.

Call order is config.provider_chain(): DeepSeek (primary) then Anthropic
(fallback). If the primary provider errors at call time, the next provider is
tried before the caller's own deterministic fallback kicks in.
"""

from typing import Any, Sequence

from .config import ANTHROPIC_MODEL, DEEPSEEK_MODEL, provider_chain


def _build(provider: str, max_tokens: int):
    if provider == "deepseek":
        from langchain_deepseek import ChatDeepSeek

        return ChatDeepSeek(model=DEEPSEEK_MODEL, max_tokens=max_tokens)
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(model=ANTHROPIC_MODEL, max_tokens=max_tokens)


def invoke_structured(schema: type, messages: Sequence[Any], max_tokens: int = 1024):
    """Run messages through the provider chain, returning `schema`-shaped output."""
    last_exc: Exception | None = None
    for provider in provider_chain():
        try:
            return _build(provider, max_tokens).with_structured_output(schema).invoke(
                list(messages)
            )
        except Exception as exc:  # try the next provider before giving up
            last_exc = exc
    raise last_exc or RuntimeError("no LLM provider configured")
