# Two stages: build the React UI with Node, then run the Python server (FastAPI + uvicorn) that also serves it.

# --- Stage 1: the web UI -------------------------------------------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /build
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY web/package.json web/
RUN npm ci --workspace shared --workspace web
COPY shared shared
COPY web web
RUN npm run build -w web

# --- Stage 2: the Python server ------------------------------------------------------------------------------------
FROM python:3.13-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
WORKDIR /app

# Dependencies first, so this layer is cached until pyproject.toml or uv.lock changes.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app app
COPY shared/record.schema.json shared/record.schema.json
COPY --from=web /build/web/dist web/dist

RUN useradd --system --no-create-home appuser
USER appuser
ENV PATH="/app/.venv/bin:$PATH" \
    NODE_ENV=production
EXPOSE 8080
# Migrations run when the app starts, before it accepts traffic. PORT and HOST come from the environment.
CMD ["python", "-m", "app"]
