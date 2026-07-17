# F2: agents service image (FastAPI + LangGraph). Build context is the REPO
# ROOT (matching the api/edge-sync images, and required by Railway which
# archives from the repo root):
#   docker build -f apps/agents/Dockerfile .
# fastembed pulls the bge-small embedding model on first use; bake it into
# the image so cold starts don't depend on network access.

FROM python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/
WORKDIR /app
COPY apps/agents/pyproject.toml apps/agents/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY apps/agents/app ./app

FROM python:3.12-slim
WORKDIR /app
COPY --from=build /app /app
ENV PATH="/app/.venv/bin:$PATH"
# Pre-download the local embedding model (non-fatal if the build is offline).
RUN python -c "from fastembed import TextEmbedding; TextEmbedding('BAAI/bge-small-en-v1.5')" || true
EXPOSE 8100
# Bind dual-stack ("::") — Railway's private network is IPv6-only.
CMD ["uvicorn", "app.main:app", "--host", "::", "--port", "8100"]
