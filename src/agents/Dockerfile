FROM --platform=linux/arm64 python:3.12-slim

WORKDIR /app

COPY runtime/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY tools/ /app/tools/
COPY runtime/ /app/runtime/
COPY server.py /app/server.py

# Run as a non-root user (CKV_DOCKER_3).
RUN useradd --create-home --uid 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 9000

# Liveness: the server is accepting TCP connections on its port (CKV_DOCKER_2).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import socket; socket.create_connection(('127.0.0.1', 9000), 3).close()" || exit 1

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "9000"]
