"""10 representative NL questions for the text-to-SQL spike.

Each has an `expects_rows` hint used only for a soft semantic sanity check
(a valid query that returns 0 rows for a question we know has data is suspicious).
THROWAWAY SPIKE CODE.
"""

QUESTIONS = [
    {"id": "q01", "nl": "How many critical NCRs per supplier in the last 30 days?",
     "expects_rows": True},
    {"id": "q02", "nl": "Show the daily earned value trend (CPI and SPI) for the ARES-1 program.",
     "expects_rows": True},
    {"id": "q03", "nl": "Which parts have the most non-conformance defects? Give me the top 5.",
     "expects_rows": True},
    {"id": "q04", "nl": "Show fleet digital-twin anomalies this month.",
     "expects_rows": True},
    {"id": "q05", "nl": "Count events by domain.",
     "expects_rows": True},
    {"id": "q06", "nl": "What is the average supplier overall score by supplier, most recent period?",
     "expects_rows": True},
    {"id": "q07", "nl": "Total matched invoice amount per supplier, sorted highest first.",
     "expects_rows": True},
    {"id": "q08", "nl": "How many work orders were started per production cell?",
     "expects_rows": True},
    {"id": "q09", "nl": "List the most common defect codes for critical or major non-conformances.",
     "expects_rows": True},
    {"id": "q10", "nl": "What was the largest hydraulic pressure deviation recorded in a digital-twin anomaly, and on which serial number?",
     "expects_rows": True},
]
