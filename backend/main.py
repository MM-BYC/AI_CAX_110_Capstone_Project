import logging
from fastapi import FastAPI

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Translate", version="2.0.0")

logger.info("=== APP STARTED ===")

@app.get("/")
def root():
    logger.info("GET / called")
    return {"message": "Hello from AI Translate on Railway"}

@app.get("/health")
def health():
    logger.info("GET /health called")
    return {"status": "ok"}

logger.info("=== APP INITIALIZED ===")
