"""Run each prompt version N times to measure stability under LLM non-determinism.

temperature=0 does NOT guarantee identical output run-to-run, so a single 10/10
can hide a flaky question. This reports correct-runs / total-runs per question.

Usage:  python stability.py v1 v3   [N]
THROWAWAY SPIKE CODE.
"""
import json
import os
import sys
from collections import defaultdict

from common import (MODEL_ID, ask_bedrock, extract_sql, hallucinated_fields,
                    null_key_result, run_athena)
from prompts import PROMPTS
from questions import QUESTIONS

RESULTS_DIR = os.path.join(os.path.dirname(__file__), "results")


def score_once(system, q):
    raw = ask_bedrock(system, q["nl"])
    sql = extract_sql(raw)
    res = run_athena(sql)
    halluc = hallucinated_fields(sql)
    empty = res["valid"] and q["expects_rows"] and res["rowcount"] == 0
    null_keys = res["valid"] and null_key_result(res["sample"])
    correct = res["valid"] and not halluc and not empty and not null_keys
    return correct, sql, res


def main(versions, n):
    report = {}
    for v in versions:
        system = PROMPTS[v]
        per_q = defaultdict(lambda: {"correct": 0, "runs": 0, "fail_samples": []})
        print(f"\n=== {v}: {n} runs x {len(QUESTIONS)} questions ===")
        for run_i in range(n):
            run_correct = 0
            for q in QUESTIONS:
                ok, sql, res = score_once(system, q)
                per_q[q["id"]]["runs"] += 1
                if ok:
                    per_q[q["id"]]["correct"] += 1
                    run_correct += 1
                elif len(per_q[q["id"]]["fail_samples"]) < 2:
                    per_q[q["id"]]["fail_samples"].append(
                        {"sql": sql, "error": res["error"], "rowcount": res["rowcount"]})
            print(f"  run {run_i+1}: {run_correct}/{len(QUESTIONS)} correct")
        # summarize
        flaky = [qid for qid, s in per_q.items() if 0 < s["correct"] < s["runs"]]
        always_wrong = [qid for qid, s in per_q.items() if s["correct"] == 0]
        total_correct = sum(s["correct"] for s in per_q.values())
        total_runs = sum(s["runs"] for s in per_q.values())
        report[v] = {
            "per_question": {k: dict(v2) for k, v2 in per_q.items()},
            "flaky": flaky, "always_wrong": always_wrong,
            "aggregate_correct_pct": round(100 * total_correct / total_runs, 1),
        }
        print(f"  {v} aggregate: {total_correct}/{total_runs} "
              f"({report[v]['aggregate_correct_pct']}%)  flaky={flaky}  always_wrong={always_wrong}")

    tag = "s5" if "sonnet-5" in MODEL_ID else "s46"
    path = os.path.join(RESULTS_DIR, f"stability_{tag}.json")
    os.makedirs(RESULTS_DIR, exist_ok=True)
    with open(path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nwrote {path}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.isdigit()] or ["v1", "v2", "v3"]
    n = next((int(a) for a in sys.argv[1:] if a.isdigit()), 3)
    main(args, n)
