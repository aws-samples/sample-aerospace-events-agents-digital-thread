# Third-Party Licenses

This project bundles the third-party content below. Each item keeps its own license file next to it.

## Industrial Ontology Foundry (IOF) — Core and Production Planning ontologies

- Path: `config/ontology/iof/` (`Core.rdf`, `ProductionPlanning.rdf`)
- License: MIT License — see [`config/ontology/iof/LICENSE`](config/ontology/iof/LICENSE)
- Copyright (c) 2022, 2023, 2024, 2025, 2026 Open Applications Group, on behalf of the Industrial Ontologies Foundry
- Source: https://github.com/iofoundry

## hsu-aut DIN EN 62264-2 ontology design pattern

- Path: `config/ontology/hsu-aut/` (`DINEN62264.owl`)
- License: MIT License — see [`config/ontology/hsu-aut/LICENSE`](config/ontology/hsu-aut/LICENSE)
- Copyright (c) 2019 ConstantinHildebrandt
- Source: https://github.com/hsu-aut/IndustrialStandard-ODP-DINEN62264-2 (v2.0.0)

## MESA International — Business To Manufacturing Markup Language (B2MML) V7.00.00

- Path: `config/schema/b2mml/V7.00.00/` (XML Schemas)
- License: MESA International B2MML license — see [`config/schema/b2mml/V7.00.00/LICENSE`](config/schema/b2mml/V7.00.00/LICENSE)
- Copyright 2020 MESA International, Version 0700. All Rights Reserved. http://www.mesa.org
- Required acknowledgement: **"The Business To Manufacturing Markup Language (B2MML) is used courtesy of MESA International."**

## AWS EventBridge Kafka Connect sink plugin (fetched at build time, not vendored)

- Path: `.build/plugins/kafka-eventbridge-sink.zip`, downloaded and checksum-verified by `scripts/fetch-connector.sh` (pinned release v1.6.1)
- License: Apache License 2.0
- Source: https://github.com/aws/eventbridge-kafka-connector
