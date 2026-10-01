FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/hf DJANGO_SETTINGS_MODULE=rxguard.settings
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential pkg-config default-libmysqlclient-dev curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/requirements.txt .
# CPU-only torch keeps the image small; then the pinned requirements
RUN pip install torch --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple \
    && pip install -r requirements.txt
# Bake the embedding model into the image so the container never downloads at request time
ARG EMBEDDING_MODEL=intfloat/multilingual-e5-base
ARG RERANK_MODEL=cross-encoder/ms-marco-MiniLM-L-6-v2
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${EMBEDDING_MODEL}')" \
    && python -c "from sentence_transformers import CrossEncoder; CrossEncoder('${RERANK_MODEL}')"
# The model is baked in: never contact the Hub at runtime
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=4
COPY backend/ /app/backend/
COPY data/corpus_manifest.yaml /app/data/corpus_manifest.yaml
COPY data/curated /app/data/curated
COPY data/synthetic /app/data/synthetic
COPY scripts /app/scripts
COPY eval /app/eval
RUN useradd -m rx && mkdir -p /app/data/index /app/data/processed /app/data/raw && chown -R rx /app/data
USER rx
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=90s CMD curl -fs http://127.0.0.1:8000/healthz || exit 1
CMD ["sh", "-c", "python manage.py migrate --noinput && gunicorn rxguard.wsgi:application --bind 0.0.0.0:8000 --workers ${GUNICORN_WORKERS:-1} --threads ${GUNICORN_THREADS:-8} --timeout 30 --access-logfile -"]
