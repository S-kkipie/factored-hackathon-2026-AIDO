# factored-hackathon-2026-AIDO

AI-first banking customer-service system for the Factored AI & Data Hackathon 2026 (team AIDO).

Status: design in progress. See `docs/data_findings.md` for the initial audit of the LATAM Bank dataset.

## Data access

Data is read from the organizer S3 bucket through a local AWS profile named `factored`.
Credentials are distributed to participants by the organizers and are never stored in this repository.

```bash
uv venv && uv pip install boto3 duckdb pandas pyarrow
.venv/bin/python scripts/download.py call_center_interactions complaints customers.csv
```
