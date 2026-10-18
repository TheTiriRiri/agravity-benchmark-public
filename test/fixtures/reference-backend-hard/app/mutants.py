"""Deliberate defects and rule switches, chosen by REFERENCE_MUTANT, that prove the hard tests bite."""
import os

ACTIVE = os.environ.get("REFERENCE_MUTANT", "")


def mutant(name: str) -> bool:
    return ACTIVE == name
