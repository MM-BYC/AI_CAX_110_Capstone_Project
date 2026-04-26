"""Language Detection Agent — identifies the source language of text."""
from langdetect import detect, LangDetectException


def run(text: str) -> str:
    try:
        return detect(text)
    except LangDetectException:
        return "en"
