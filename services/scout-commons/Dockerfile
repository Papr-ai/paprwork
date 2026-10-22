# Scout Commons — one image, three entry points:
#   service (default): uvicorn commons.api:app            → Cloud Run service
#   worker:            python -m commons.compute          → Cloud Run job, every 5 min
#   build:             python -m commons.build            → Cloud Batch / VM, quarterly (16 GB RAM, 60 GB disk)
# COMMONS_DATA_DIR points at the GCS bucket mount (Cloud Run volume mount, gcsfuse).
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 COMMONS_DATA_DIR=/mnt/commons
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY commons ./commons
RUN useradd -r -u 10001 commons && chown -R commons /app
USER commons
EXPOSE 8080
CMD ["sh", "-c", "uvicorn commons.api:app --host 0.0.0.0 --port ${PORT:-8080} --workers ${WEB_CONCURRENCY:-2}"]
