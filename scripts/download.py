"""Mirror selected tables from the organizer S3 bucket into data/raw/."""
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import boto3

BUCKET = "factored-datathon-2026-s3-157725502942-us-east-2-an"
OUT = Path(__file__).resolve().parent.parent / "data" / "raw"

s3 = boto3.Session(profile_name="factored").client("s3")


def keys(prefix):
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
        for o in page.get("Contents", []):
            yield o["Key"], o["Size"]


def fetch(item):
    key, size = item
    dest = OUT / key.removeprefix("data/")
    if dest.exists() and dest.stat().st_size == size:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    s3.download_file(BUCKET, key, str(dest))


if __name__ == "__main__":
    for table in sys.argv[1:]:
        items = list(keys(f"data/{table}"))
        with ThreadPoolExecutor(32) as ex:
            list(ex.map(fetch, items))
        print(f"{table}: {len(items)} files")
