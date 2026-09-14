#!/usr/bin/env bash
set -euo pipefail

STACK_NAME="AerospaceAppStack"
PROFILE="${AWS_PROFILE:-}"   # optional: default credential chain when unset
REGION="${AWS_REGION:-eu-west-1}"

echo "Extracting outputs from CDK stacks..."

get_output() {
  local stack="$1"
  local key="$2"
  aws cloudformation describe-stacks \
    --stack-name "$stack" \
    ${PROFILE:+--profile "$PROFILE"} \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?ExportName=='$key'].OutputValue" \
    --output text
}

APPSYNC_ENDPOINT=$(get_output "$STACK_NAME" "AerospaceAppSyncEndpoint")
APPSYNC_REGION=$(get_output "$STACK_NAME" "AerospaceAppSyncRegion")
USER_POOL_ID=$(get_output "$STACK_NAME" "AerospaceUserPoolId")
USER_POOL_CLIENT_ID=$(get_output "$STACK_NAME" "AerospaceUserPoolClientId")
IDENTITY_POOL_ID=$(get_output "$STACK_NAME" "AerospaceIdentityPoolId")
IOT_ENDPOINT=$(get_output "AerospaceIoTCoreStack" "AerospaceIoTEndpoint" 2>/dev/null || echo "")
API_GATEWAY_URL=$(get_output "AerospaceApiGatewayStack" "AerospaceApiGatewayUrl" 2>/dev/null || echo "")

# AG-UI analytics agent — build the AgentCore Runtime data-plane invoke URL from the
# runtime ARN (the browser POSTs the AG-UI RunAgentInput here and reads back SSE).
AGUI_RUNTIME_ARN=$(get_output "AerospaceAgUiStack" "AerospaceAgUiRuntimeArn" 2>/dev/null || echo "")
if [ -n "$AGUI_RUNTIME_ARN" ]; then
  AGUI_ARN_ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$AGUI_RUNTIME_ARN")
  AGUI_URL="https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${AGUI_ARN_ENC}/invocations?qualifier=DEFAULT"
else
  AGUI_URL=""
fi

# Digital Thread Navigator agent — same data-plane invoke URL shape, from its own runtime ARN.
NAV_RUNTIME_ARN=$(get_output "AerospaceThreadNavigatorStack" "AerospaceThreadNavigatorRuntimeArn" 2>/dev/null || echo "")
if [ -n "$NAV_RUNTIME_ARN" ]; then
  NAV_ARN_ENC=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$NAV_RUNTIME_ARN")
  NAV_URL="https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${NAV_ARN_ENC}/invocations?qualifier=DEFAULT"
else
  NAV_URL=""
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../src/frontend/.env.local"

cat > "$ENV_FILE" <<EOF
VITE_APPSYNC_ENDPOINT=$APPSYNC_ENDPOINT
VITE_AWS_REGION=$APPSYNC_REGION
VITE_USER_POOL_ID=$USER_POOL_ID
VITE_USER_POOL_CLIENT_ID=$USER_POOL_CLIENT_ID
VITE_IDENTITY_POOL_ID=$IDENTITY_POOL_ID
VITE_IOT_ENDPOINT=$IOT_ENDPOINT
VITE_API_GATEWAY_URL=$API_GATEWAY_URL
VITE_AGUI_URL=$AGUI_URL
VITE_AGUI_THREAD_URL=$NAV_URL
EOF

echo "Written to $ENV_FILE"
cat "$ENV_FILE"
