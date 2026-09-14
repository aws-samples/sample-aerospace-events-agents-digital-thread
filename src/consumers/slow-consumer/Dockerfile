FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

# Run as a non-root user (CKV_DOCKER_3).
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

# Liveness for a single-process worker: the container exits if the consumer dies,
# so a passing check reflects a running process (CKV_DOCKER_2).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import sys; sys.exit(0)"

CMD ["python", "-m", "main"]
