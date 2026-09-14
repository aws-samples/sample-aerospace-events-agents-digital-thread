"""Run the text-to-SQL spike for one prompt version.

Usage:  python run_spike.py v1     (or v2, v3)
Writes results/<version>.json and prints a per-question + summary table.
THROWAWAY SPIKE CODE.
"""
import json
import os
import sys

from common import (MAX_TOKENS, MODEL_ID, ask_bedrock, extract_sql,
                    hallucinated_fields, null_key_result, run_athena)
from prompts import PROMPTS
from questions import QUESTIONS

RESULTS_DIR = os.path.join(os.path.dirname(__file__), "results")


def main(version: str):
    system = PROMPTS[version]
    out = []
    print(f"\n=== PROMPT {version} | model={MODEL_ID} | max_tokens={MAX_TOKENS} | {len(QUESTIONS)} questions ===\n")
    for q in QUESTIONS:
        raw = ask_bedrock(system, q["nl"])
        sql = extract_sql(raw)
        res = run_athena(sql)
        # --- correctness signals (beyond "it executed") ---
        halluc = hallucinated_fields(sql)          # payload paths not in the table
        empty = res["valid"] and q["expects_rows"] and res["rowcount"] == 0
        null_keys = res["valid"] and null_key_result(res["sample"])  # GROUP BY ghost field
        # A query is "correct" only if it ran, hit real fields, isn't empty-when-it-shouldn't-be,
        # and didn't bucket everything under a NULL (hallucinated-dimension) key.
        correct = res["valid"] and not halluc and not empty and not null_keys
        rec = {
            "id": q["id"], "nl": q["nl"], "sql": sql,
            "valid": res["valid"], "rowcount": res["rowcount"],
            "latency_s": res["latency_s"], "error": res["error"],
            "hallucinated_fields": halluc, "suspicious_empty": empty,
            "null_group_key": null_keys, "correct": correct, "sample": res["sample"],
        }
        out.append(rec)
        if not res["valid"]:
            status = "FAIL"
        elif not correct:
            status = "WRONG"
        else:
            status = "OK "
        print(f"[{q['id']}] {status}  rows={res['rowcount']:<4} {res['latency_s']}s  {q['nl']}")
        if not res["valid"]:
            print(f"        ERROR: {res['error'][:180]}")
        if halluc:
            print(f"        HALLUCINATED payload fields: {halluc}")
        if null_keys:
            print(f"        NULL group key (grouped on a non-existent field)")

    valid = sum(r["valid"] for r in out)
    correct = sum(r["correct"] for r in out)
    print(f"\n--- {version}: {valid}/{len(out)} executed valid | {correct}/{len(out)} SEMANTICALLY CORRECT ---")

    os.makedirs(RESULTS_DIR, exist_ok=True)
    tag = "s5" if "sonnet-5" in MODEL_ID else "s46"
    path = os.path.join(RESULTS_DIR, f"{version}_{tag}.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=2)
    print(f"wrote {path}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "v1")
