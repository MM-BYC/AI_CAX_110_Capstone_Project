"""Keyboard Input Agent — normalises text typed by a conversation participant."""
import re


def run(text: str) -> str:
    """Strip surrounding whitespace and collapse internal runs of spaces."""
    return re.sub(r" {2,}", " ", text.strip())
