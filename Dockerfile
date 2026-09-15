FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bot.py .
ENV PORT=8080 DB_PATH=/data/mailbot.db
VOLUME /data
CMD gunicorn -w 2 -b 0.0.0.0:${PORT} --timeout 120 bot:app
