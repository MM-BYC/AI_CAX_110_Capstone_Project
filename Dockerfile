# Use Python 3.12 slim image
FROM python:3.12-slim

# Install system dependencies (ffmpeg required for Whisper)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy entire project
COPY . .

# Install Python dependencies from requirements.txt
RUN pip install --no-cache-dir -U pip setuptools && \
    pip install --no-cache-dir -r backend/requirements.txt

# Expose port for FastAPI
EXPOSE 8000

# Set Python path so agents module is discoverable
ENV PYTHONPATH=/app/backend:$PYTHONPATH

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:8000/docs')" || exit 1

# Start FastAPI with Uvicorn
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
