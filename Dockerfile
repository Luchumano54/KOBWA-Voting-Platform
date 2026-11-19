FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv/app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN useradd --system --uid 10001 apex && mkdir -p /data && chown -R apex /data
ENV DATABASE_PATH=/data/apexrewards.db UPLOAD_DIR=/data/uploads
USER apex
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/healthz')"
# SQLite in WAL mode handles several workers; the long timeout covers bulk voter imports.
CMD ["gunicorn", "-b", "0.0.0.0:8000", "-w", "3", "--timeout", "120", "wsgi:app"]
