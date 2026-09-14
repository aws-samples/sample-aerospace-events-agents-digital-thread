#!/usr/bin/env bash
# Fetch the AWS EventBridge Kafka Connect sink plugin at build time.
#
# MskConnectStack (src/infra/lib/msk-connect-stack.ts) uploads .build/plugins/*.zip to
# S3 and its CustomPlugin references plugins/kafka-eventbridge-sink.zip — so the file
# MUST be named kafka-eventbridge-sink.zip. We fetch that plugin from its official
# release instead of committing the 34 MB artifact — the vendored copy bundled an
# out-of-date Netty (grype CVEs) and bloated the repo.
#
# Run before `cdk deploy` of the MSK Connect / EventBridge stack:
#   ./scripts/fetch-connector.sh && (cd src/infra && npx cdk deploy AerospaceMskConnectStack)
set -euo pipefail

VERSION="${CONNECTOR_VERSION:-v1.6.1}"
URL="https://github.com/aws/eventbridge-kafka-connector/releases/download/${VERSION}/aws-kafka-eventbridge-sink-${VERSION}.zip"

DEST_DIR="$(cd "$(dirname "$0")/.." && pwd)/.build/plugins"
DEST="${DEST_DIR}/kafka-eventbridge-sink.zip"
# SHA-256 of the pinned release asset. Overriding CONNECTOR_VERSION requires CONNECTOR_SHA256 too.
SHA256="${CONNECTOR_SHA256:-858153a5547ae969d4d648aef4411aad2afaa647578edaba470c29d317b8a004}"

mkdir -p "$DEST_DIR"
if [ -f "$DEST" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "Connector already present: $DEST (set FORCE=1 to re-download)"
  exit 0
fi

echo "Downloading EventBridge Kafka connector ${VERSION}…"
curl -fsSL -o "$DEST" "$URL"
echo "${SHA256}  ${DEST}" | shasum -a 256 -c - >/dev/null || { echo "Checksum mismatch for $DEST" >&2; rm -f "$DEST"; exit 1; }
echo "Wrote $DEST ($(du -h "$DEST" | cut -f1))"
