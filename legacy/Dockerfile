FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir -r requirements.txt \
    && useradd --create-home --uid 10001 skyshift \
    && install -d -o skyshift -g skyshift /app/cache
COPY server.py ./
COPY pipeline/ pipeline/
COPY dist/ dist/
ENV SKYSHIFT_HOST=0.0.0.0 SKYSHIFT_CACHE_DIR=/app/cache PORT=8000
USER skyshift
EXPOSE 8000
CMD ["python", "-B", "server.py"]
