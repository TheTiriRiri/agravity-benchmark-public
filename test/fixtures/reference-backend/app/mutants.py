"""Deliberate defects, switched on by REFERENCE_MUTANT, that prove the hidden tests bite."""
import os

ACTIVE = os.environ.get("REFERENCE_MUTANT", "")


def mutant(name: str) -> bool:
    return ACTIVE == name
