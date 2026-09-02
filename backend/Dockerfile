FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
COPY migrations ./migrations

EXPOSE 8000

CMD ["sh", "-c", "python -m cinemind.scripts.bootstrap_catalog && uvicorn cinemind.main:app --host 0.0.0.0 --port 8000"]
