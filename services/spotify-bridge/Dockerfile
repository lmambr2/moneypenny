FROM python:3.12-slim
WORKDIR /app
COPY server.py .
ENV PORT=8082
EXPOSE 8082
CMD ["python", "-u", "server.py"]
