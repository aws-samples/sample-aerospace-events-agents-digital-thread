#!/usr/bin/env bash
# Reset demo — pause generators, wipe all storage, optionally restart.
#
# Usage:
#   ./scripts/reset-demo.sh              # full reset + restart generators
#   ./scripts/reset-demo.sh --no-restart # reset only — generators stay stopped
#   ./scripts/start-generators.sh        # start generators (separate script)
#   ./scripts/stop-generators.sh         # stop generators (separate script)
set -uo pipefail

NO_RESTART=false
for arg in "$@"; do
  case $arg in
    --no-restart) NO_RESTART=true ;;
  esac
done

# AWS_PROFILE is optional: without it the default credential chain is used.
export AWS_REGION=${AWS_REGION:-eu-west-1}

# Pick a Python interpreter that can import boto3: an activated venv, then a repo .venv,
# then the system python.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GIT_TOP="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "")"
GIT_COMMON="$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "")"
PRIMARY_ROOT="${GIT_COMMON:+$(dirname "$GIT_COMMON")}"
PY=""
for cand in "${VIRTUAL_ENV:-}/bin/python" "${SCRIPT_DIR}/../.venv/bin/python" \
            "${GIT_TOP}/.venv/bin/python" "${PRIMARY_ROOT}/.venv/bin/python" python3 python; do
  [ -n "$cand" ] || continue
  if "$cand" -c 'import boto3' >/dev/null 2>&1; then PY="$cand"; break; fi
done
if [ -z "$PY" ]; then
  echo "ERROR: no Python with boto3 found (tried \$VIRTUAL_ENV, ${SCRIPT_DIR}/../.venv, python3, python)." >&2
  echo "  Create it, e.g.:  uv venv .venv && uv pip install boto3   (or: python3 -m venv .venv && .venv/bin/pip install boto3)" >&2
  exit 1
fi

echo "=== Fetching stack outputs ==="

cfn_output() {
  local stack=$1 key=$2
  aws cloudformation describe-stacks --stack-name "$stack" \
    --query "Stacks[0].Outputs[?OutputKey==\`$key\`].OutputValue" --output text 2>/dev/null || echo ""
}

NEPTUNE_ENDPOINT=$(cfn_output AerospaceNeptuneStack NeptuneEndpoint)
NEPTUNE_PORT=$(cfn_output AerospaceNeptuneStack NeptunePort)
DATALAKE_BUCKET=$(cfn_output AerospaceStorageStack DatalakeBucketName)
ATHENA_RESULTS_BUCKET="aerospace-athena-results-${AWS_REGION}-$(aws sts get-caller-identity --query Account --output text)"
SESSION_BUCKET=$(cfn_output AerospaceAgentCoreStack SessionBucketName)
GENERATOR_CLUSTER=$(cfn_output AerospaceGeneratorStack GeneratorClusterName)

echo "  Neptune:    ${NEPTUNE_ENDPOINT:-not found}"
echo "  Datalake:   ${DATALAKE_BUCKET:-not found}"
echo "  Athena:     ${ATHENA_RESULTS_BUCKET}"
echo "  Sessions:   ${SESSION_BUCKET:-not found}"
echo "  Generator:  ${GENERATOR_CLUSTER:-not found}"
if $NO_RESTART; then
  echo "  Mode:       --no-restart (generators will stay stopped)"
fi

# All DDB tables to wipe
TABLES=(
  qms-demo
  mes-demo
  plm-demo
  erp-demo
  srm-demo
  wms-demo
  dhr-demo
  program-demo
  inservice-demo
  hitl-questions
  digital-thread-offsets
  graph-write-dlq
  agent-trace
  demo-control
)

# ─── 1. Pause generator ──────────────────────────────────────────────
echo ""
echo "=== 1. Stopping generators ==="
SERVICE=""
if [ -n "$GENERATOR_CLUSTER" ]; then
  SERVICE=$(aws ecs list-services --cluster "$GENERATOR_CLUSTER" --query 'serviceArns[0]' --output text 2>/dev/null || echo "")
  if [ -n "$SERVICE" ] && [ "$SERVICE" != "None" ]; then
    aws ecs update-service --cluster "$GENERATOR_CLUSTER" --service "$SERVICE" --desired-count 0 \
      --query 'service.desiredCount' --output text
    echo "  Waiting for tasks to drain..."
    sleep 15
    echo "  Generators stopped."
  else
    echo "  No generator service found — skipping."
  fi
else
  echo "  Generator cluster not found — skipping."
fi

# ─── 2. Wipe DynamoDB tables ─────────────────────────────────────────
echo ""
echo "=== 2. Wiping DynamoDB tables ==="
for TABLE in "${TABLES[@]}"; do
  echo -n "  $TABLE: "

  if ! aws dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
    echo "not found"
    continue
  fi

  "$PY" -c "
import boto3, sys

table = boto3.resource('dynamodb', region_name='${AWS_REGION}').Table('${TABLE}')
response = table.scan(ProjectionExpression='PK,SK')
items = response.get('Items', [])

while response.get('LastEvaluatedKey'):
    response = table.scan(
        ProjectionExpression='PK,SK',
        ExclusiveStartKey=response['LastEvaluatedKey']
    )
    items.extend(response.get('Items', []))

if not items:
    print('empty')
    sys.exit(0)

with table.batch_writer() as batch:
    for item in items:
        batch.delete_item(Key={'PK': item['PK'], 'SK': item['SK']})

print(f'{len(items)} deleted')
"
done

# ─── 3. Wipe Neptune graph ───────────────────────────────────────────
echo ""
echo "=== 3. Wiping Neptune graph ==="
if [ -n "$NEPTUNE_ENDPOINT" ]; then
  NEPTUNE_FN=$(cfn_output AerospaceNeptuneStack NeptuneQueryFnArn)
  if [ -n "$NEPTUNE_FN" ]; then
    INVOKE_RESULT=$(aws lambda invoke --function-name "$NEPTUNE_FN" \
      --cli-binary-format raw-in-base64-out \
      --payload '{"body":"{\"operation\":\"drop_all\"}"}' \
      /tmp/neptune-drop.json 2>&1) || true
    BODY=$(cat /tmp/neptune-drop.json 2>/dev/null || echo "{}")
    if echo "$BODY" | grep -q 'dropped.*true'; then
      echo "  Graph dropped via Lambda."
    else
      echo "  Graph drop may have failed: $BODY"
    fi
  else
    echo "  Neptune query Lambda not found — skipping."
  fi
else
  echo "  Neptune not deployed — skipping."
fi

# ─── 4. Wipe S3 datalake ─────────────────────────────────────────────
echo ""
echo "=== 4. Wiping S3 storage ==="

wipe_s3_prefix() {
  local bucket=$1 prefix=$2
  if [ -z "$bucket" ]; then echo "  $prefix: bucket not found"; return; fi
  echo -n "  s3://${bucket}/${prefix} — "
  OUTPUT=$(aws s3 rm "s3://${bucket}/${prefix}" --recursive 2>&1) || true
  COUNT=$(echo "$OUTPUT" | grep -c "^delete:" || true)
  if [ "$COUNT" -gt 0 ] 2>/dev/null; then
    echo "${COUNT} objects deleted"
  else
    echo "empty"
  fi
}

# Clear Iceberg data via Athena DELETE (preserves Firehose metadata sync)
echo -n "  Clearing Iceberg via Athena: "
"$PY" -c "
import boto3, time
athena = boto3.client('athena', region_name='${AWS_REGION}')
resp = athena.start_query_execution(
    QueryString='DELETE FROM aerospace_events.domain_events WHERE 1=1',
    WorkGroup='aerospace-dashboards',
    QueryExecutionContext={'Database': 'aerospace_events'},
)
qid = resp['QueryExecutionId']
for _ in range(30):
    time.sleep(2)
    status = athena.get_query_execution(QueryExecutionId=qid)['QueryExecution']['Status']['State']
    if status in ('SUCCEEDED', 'FAILED', 'CANCELLED'):
        break
print(f'{status}')
" 2>&1 || echo "FAILED"

wipe_s3_prefix "$ATHENA_RESULTS_BUCKET" "results/"
wipe_s3_prefix "$SESSION_BUCKET" "agents/"
wipe_s3_prefix "$DATALAKE_BUCKET" "iceberg-failed/"
wipe_s3_prefix "$DATALAKE_BUCKET" "iceberg-failedIcebergCommitFailed/"

# ─── 5. Restart generator (unless --no-restart) ──────────────────────
echo ""
if $NO_RESTART; then
  echo "=== 5. Generators left stopped (--no-restart) ==="
  echo "  Run: ./scripts/start-generators.sh"
  echo "  Or seed first: $PY scripts/seed-baseline.py"
else
  echo "=== 5. Restarting generators ==="
  if [ -n "$GENERATOR_CLUSTER" ] && [ -n "$SERVICE" ] && [ "$SERVICE" != "None" ]; then
    aws ecs update-service --cluster "$GENERATOR_CLUSTER" --service "$SERVICE" \
      --desired-count 1 --force-new-deployment \
      --query 'service.desiredCount' --output text >/dev/null
    echo "  Generators restarting. Fresh data in ~60 seconds."
  else
    echo "  No generator to restart."
  fi
fi

echo ""
echo "=== Done ==="
if $NO_RESTART; then
  echo "All storage wiped. Generators stopped."
  echo "Typical workflow:"
  echo "  1. $PY scripts/seed-baseline.py    # seed 90-day history"
  echo "  2. ./scripts/start-generators.sh       # start live events"
else
  echo "All storage wiped. Generators restarted with clean state."
fi
