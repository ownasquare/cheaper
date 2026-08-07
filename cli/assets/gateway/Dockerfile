# Cheaper gateway — adaptive model-routing proxy (Anthropic Messages + OpenAI Chat
# Completions compatible). Built + shipped by ../../cheaper-deploy.sh.
#
#   docker build -t cheaper-gateway:<ver> .
#   docker run -p 8787:8787 -v cheaper-data:/data cheaper-gateway:<ver>
#   # then: export ANTHROPIC_BASE_URL=http://localhost:8787   (or .../v1 for OpenAI tools)
FROM python:3.11-slim

LABEL org.opencontainers.image.title="cheaper-gateway" \
      org.opencontainers.image.description="Cheaper adaptive model-routing gateway" \
      org.opencontainers.image.source="https://github.com/ownasquare/cheaper"

WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    CHEAPER_PORT=8787 \
    CHEAPER_DB=/data/metrics.db

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt && mkdir -p /data
COPY app ./app

EXPOSE 8787
VOLUME ["/data"]

# exec form via sh so ${CHEAPER_PORT} is expanded at runtime.
CMD ["sh", "-c", "exec uvicorn --app-dir app app:app --host 0.0.0.0 --port ${CHEAPER_PORT}"]
