FROM python:3.12-slim
WORKDIR /app
COPY server.py .
ENV PORT=7865 OUTPUT_DIR=/music/generated/ace-step ACE_STEP_MOCK=1
EXPOSE 7865
CMD ["python", "-u", "server.py"]
