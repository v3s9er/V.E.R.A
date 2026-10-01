"""Data-only preparation. Pinned public AIMO data; never execute upstream code."""
import argparse
import hashlib
import io
import json
import re
import urllib.request
from pathlib import Path

REVISION = "13f9e12f613e720c2a2b2f345dd04b998a29494d"
PARQUET_SHA256 = "025484a99fea498e7d0c3b0ee42afcbec0176405c19c5dbf557b9f6ca6445675"
URL = f"https://huggingface.co/datasets/AI-MO/aimo-validation-aime/resolve/{REVISION}/data/train-00000-of-00001.parquet"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    target = Path(args.out).resolve()
    if target.exists():
        raise ValueError("Existing data is not overwritten")
    import pyarrow.parquet as pq
    with urllib.request.urlopen(URL, timeout=30) as response:
        data = response.read(1_000_001)
    if hashlib.sha256(data).hexdigest() != PARQUET_SHA256:
        raise ValueError("Pinned dataset checksum mismatch")
    rows = pq.read_table(io.BytesIO(data)).to_pylist()
    records = []
    for row in rows:
        match = re.search(r"/(202[234])_AIME_(I{1,2})_Problems/Problem_(\d{1,2})$", row["url"])
        if not match or not re.fullmatch(r"\d{1,3}", row["answer"].strip()):
            raise ValueError("Unexpected competition record")
        year, exam, number = match.groups()
        records.append({"id": f"{year}-AIME-{exam}-{int(number):02d}", "year": int(year),
                        "exam": exam, "number": int(number), "problem": row["problem"],
                        "answer": int(row["answer"]), "url": row["url"]})
    if len(records) != 90 or len({row["id"] for row in records}) != 90:
        raise ValueError("Incomplete/duplicate dataset")
    records.sort(key=lambda row: (row["year"], row["exam"], row["number"]))
    value = {"dataset": "AI-MO/aimo-validation-aime", "revision": REVISION,
             "parquetSha256": PARQUET_SHA256, "declaredLicense": "apache-2.0", "records": records}
    encoded = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("xb") as output:
        output.write(encoded)
    print(json.dumps({"records": len(records), "sha256": hashlib.sha256(encoded).hexdigest(), "accountUsage": False}))


if __name__ == "__main__":
    main()
