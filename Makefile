.PHONY: test lint typecheck check catalog normalize

test:
	PYTHONPATH=src python -m unittest discover -s tests -v

lint:
	python -m ruff check src tests

typecheck:
	python -m mypy src

check: test lint typecheck

catalog:
	PYTHONPATH=src python -m persona_timeline_rag catalog

normalize:
	PYTHONPATH=src python -m persona_timeline_rag normalize
