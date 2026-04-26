import os
import logging
from fastapi import FastAPI

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="AI Translate", version="2.0.0")

port = os.environ.get("PORT", "8000")
logger.info(f"=== APP STARTED - PORT={port} ===")

@app.get("/")
def root():
    logger.info("GET / called")
    return {"message": "Hello from Railway"}

@app.get("/health")
def health():
    logger.info("GET /health called")
    return {"status": "ok"}

logger.info(f"=== APP INITIALIZED on PORT {port} ===")
