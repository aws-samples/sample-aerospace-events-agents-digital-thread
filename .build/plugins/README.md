# MSK Connect plugin

`kafka-eventbridge-sink.zip` (the AWS EventBridge Kafka Connect sink plugin) is **not
committed** — it is fetched at build time from the official release so the repo carries
no large third-party binary and stays current with upstream dependency fixes. The name
matches the `fileKey` the MSK Connect CustomPlugin expects.

Fetch it before deploying the MSK Connect / EventBridge stack:

```bash
./scripts/fetch-connector.sh
```

Source: <https://github.com/aws/eventbridge-kafka-connector/releases> (pinned to
`v1.6.1` in `scripts/fetch-connector.sh`, SHA-256 verified; override with `CONNECTOR_VERSION` +
`CONNECTOR_SHA256`). The plugin is licensed under Apache-2.0 by AWS.
