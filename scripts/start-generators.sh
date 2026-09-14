#!/usr/bin/env bash
# Start the ECS generator service.
# Usage: ./scripts/start-generators.sh
set -euo pipefail

# AWS_PROFILE is optional: without it the default credential chain is used.
export AWS_REGION=${AWS_REGION:-eu-west-1}

CLUSTER=$(aws cloudformation describe-stacks --stack-name AerospaceGeneratorStack \
  --query "Stacks[0].Outputs[?OutputKey=='GeneratorClusterName'].OutputValue" --output text 2>/dev/null || echo "")

if [ -z "$CLUSTER" ]; then
  echo "Generator cluster not found." >&2; exit 1
fi

SERVICE=$(aws ecs list-services --cluster "$CLUSTER" --query 'serviceArns[0]' --output text 2>/dev/null)

if [ -z "$SERVICE" ] || [ "$SERVICE" = "None" ]; then
  echo "No generator service found." >&2; exit 1
fi

CURRENT=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].desiredCount' --output text)

if [ "$CURRENT" -gt 0 ] 2>/dev/null; then
  echo "Generators already running (desiredCount=$CURRENT)."
  exit 0
fi

aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --desired-count 1 --force-new-deployment \
  --query 'service.desiredCount' --output text >/dev/null

echo "Generators starting. Fresh data in ~60 seconds."
