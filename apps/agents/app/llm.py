"""Provider-agnostic structured LLM invocation.

Call order is config.provider_chain(): DeepSeek (primary) then Anthropic
(fallback). If the primary provider errors at call time, the next provider is
tried before the caller's own deterministic fallback kicks in.

F2: this is the single choke point for prompt de-identification. Callers pass
their per-request Deidentifier; message contents are scrubbed of registered
names (plus phones/emails by pattern) before any provider sees them, and the
structured output's string fields are re-hydrated before it returns — the
model reasons over [PATIENT_N] tokens, the platform keeps the real values.
"""

from typing import Any, Sequence

from pydantic import BaseModel

from .config import ANTHROPIC_MODEL, DEEPSEEK_MODEL, provider_chain
from .deid import Deidentifier


def _build(provider: str, max_tokens: int):
    if provider == "deepseek":
        from langchain_deepseek import ChatDeepSeek

        return ChatDeepSeek(model=DEEPSEEK_MODEL, max_tokens=max_tokens)
    from langchain_anthropic import ChatAnthropic

    return ChatAnthropic(model=ANTHROPIC_MODEL, max_tokens=max_tokens)


def _rehydrate(obj: Any, deid: Deidentifier) -> Any:
    """Recursively restore tokens in every string field of the output."""
    if isinstance(obj, str):
        return deid.rehydrate(obj)
    if isinstance(obj, BaseModel):
        for name in type(obj).model_fields:
            object.__setattr__(obj, name, _rehydrate(getattr(obj, name), deid))
        return obj
    if isinstance(obj, list):
        return [_rehydrate(x, deid) for x in obj]
    if isinstance(obj, dict):
        return {k: _rehydrate(v, deid) for k, v in obj.items()}
    return obj


def invoke_structured(
    schema: type,
    messages: Sequence[Any],
    max_tokens: int = 1024,
    deid: Deidentifier | None = None,
):
    """Run messages through the provider chain, returning `schema`-shaped output."""
    if deid is not None:
        messages = [
            m.model_copy(update={"content": deid.scrub(m.content)})
            if isinstance(getattr(m, "content", None), str) else m
            for m in messages
        ]
    last_exc: Exception | None = None
    for provider in provider_chain():
        try:
            result = _build(provider, max_tokens).with_structured_output(schema).invoke(
                list(messages)
            )
            return _rehydrate(result, deid) if deid is not None else result
        except Exception as exc:  # try the next provider before giving up
            last_exc = exc
    raise last_exc or RuntimeError("no LLM provider configured")
