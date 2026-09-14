# Scenario Author — ARES-1 Aerospace Digital Thread

## Overview
You generate a complete JSONL event file for the ARES-1 aerospace demo from a YAML narrative outline. The output drives a 10-minute scripted demo where one aircraft goes from design to in-service operation with timed drama moments.

## Parameters
- **outline_path** (required): Path to the YAML narrative outline
- **output_path** (required): Path for the output JSONL file
- **serial_number** (optional, default: "SN-0047"): Primary aircraft serial number

## Steps

### 1. Read the Outline
Read the YAML outline file. Extract:
- Seed events (historical, phase=seed, t_sec <= 0)
- Live events (real-time replay, phase=live, t_sec > 0)
- Drama beats (marked with `drama: true`)
- Timing for each event group

**Constraints:**
- You MUST read the outline before generating any events
- You MUST NOT invent story beats not in the outline

### 2. Generate Seed Events
Generate events for the historical period. Write to JSONL using the data model below.

**Dependency order (MUST follow):**
1. PLM: Parts, Drawings, ECOs (foundation)
2. ERP: Purchase Orders (reference suppliers + parts)
3. ERP: Material Receipts + Lots (reference POs)
4. SRM: Supplier score updates (reference suppliers)
5. MES: Work Orders (reference parts + serial numbers)
6. WMS: Kit staging (reference WOs + lots)
7. DHR: Operation sign-offs, cert links, test records (reference SNs)
8. Program: Milestones and EV metrics
9. InService: Digital twin readings (if applicable)

**Graph Node Targets (MUST achieve in seed phase):**
| Node Type | Target Count | How Created |
|-----------|-------------|-------------|
| Part | 5 | PLM part_release (one per part number) |
| Drawing | 5 | PLM drawing_release (one per part) |
| ECO | 5 | PLM eco (spread across parts) |
| Supplier | 3 | SRM score updates (one per supplier) |
| PurchaseOrder | 15 | ERP purchase_order (5 per supplier, different parts) |
| Lot | 15 | ERP receipt (unique lot per receipt, different suppliers) |
| Kit | 20 | WMS kit_staged (one per WO, reference different lots) |
| WorkOrder | 20 | MES work_order (4 per part × 5 ops, use different cells/operators) |
| Machine | 5 | Referenced in MES WOs (cnc-mill-3, cnc-mill-4, lathe-1, drill-press-1, drill-press-2) |
| SerialNumber | 1 | SN-0047 (referenced in all MES/DHR/QMS events) |
| NonConformance | 5 | QMS ncr (mix of MINOR/MAJOR, different defect codes) |
| Certificate | 8 | DHR cert_link (2 per cert type: MATERIAL, PROCESS, NDT, HEAT_TREAT) |
| TestRecord | 10 | DHR test_record (2 per test type: DIMENSIONAL, NDT_UT, NDT_FPI, HARDNESS, SURFACE_ROUGHNESS) |
| Milestone | 5 | Program milestone (CDR, PDR, FAI-Complete, First-Flight, Type-Cert) |
| DigitalTwin | 0 | Created in live phase |
| FleetAnomaly | 0 | Created in live phase |

**CRITICAL: Graph Diversity Rules:**
- You MUST generate EXACTLY the target counts above — not more, not fewer
- Every WorkOrder MUST reference a DIFFERENT part+operation combination
- Every PurchaseOrder MUST reference a DIFFERENT supplier+part combination
- Every Lot MUST have a UNIQUE lot number (LOT-7731 through LOT-7745)
- Every Kit MUST reference a DIFFERENT WorkOrder AND a DIFFERENT Lot
- DHR sign-offs: ONE per completed WorkOrder (20 sign-offs for 20 WOs)
- Certificates: spread across cert types (not all MATERIAL_CERT)
- Tests: spread across test types (not all DIMENSIONAL)
- NCRs: use different defect codes and reference different parts

**Constraints:**
- All seed events MUST have `lastModifiedBy: "seed-baseline"` (agents skip seed events)
- All seed events MUST have `phase: "seed"` and `t_sec: 0`
- IDs MUST be deterministic (e.g., `PO-90001` not random) for consistency
- Every Part MUST have a Drawing and at least one ECO
- Every PO MUST have a corresponding Receipt + Lot
- Every Work Order MUST have a Kit
- Every operation sign-off MUST reference a real Work Order
- Total seed events should be ~130-150 (quality over quantity — every event creates a unique graph node/edge)

### 3. Generate Live Events
Generate events for the 10-minute real-time phase. Space events across the timeline.

**Constraints:**
- Each "minute" SHOULD have 5-10 events across multiple domains
- Drama events MUST match the outline's drama beats exactly
- Smooth events MUST use only smooth statuses (see data model below)
- Drama events use problematic statuses as specified in the outline
- Live events MUST NOT have `lastModifiedBy: "seed-baseline"` (agents MUST process them)
- Live events MUST have `phase: "live"` and `t_sec` = seconds from demo start (0-600)
- correlationIds MUST link related events (e.g., NCR and its related WO share correlationId)

### 4. Validate
Before writing output, check:
- Every Part has a Drawing
- Every PO has a Receipt
- Every Work Order references a valid Part
- Every DHR record references SN-0047
- No duplicate PK+SK combinations
- All IDs are consistent across domains
- Drama events have correct timing and severity

### 5. Write JSONL
Write one event per line, sorted by t_sec (seed first, then live).

**JSONL format:**
```json
{"t_sec": 0, "phase": "seed", "domain": "plm", "table": "plm-demo", "item": {...}}
```

## Data Model Reference

### Entity IDs and Constants

```yaml
serial_number: SN-0047
program: ARES-1

parts:
  44821-003: {desc: "Wing box bore fitting", dwg: "DWG-44821-003-001", rev: "C", critical: true}
  44821-007: {desc: "Spar cap bracket", dwg: "DWG-44821-007-001", rev: "B", critical: false}
  44821-012: {desc: "Rib attachment lug", dwg: "DWG-44821-012-001", rev: "C", critical: false}
  55192-001: {desc: "Structural bracket assy", dwg: "DWG-55192-001-001", rev: "A", critical: true}
  55192-004: {desc: "Shear tie clip", dwg: "DWG-55192-004-001", rev: "B", critical: false}

suppliers:
  titan-forge: {name: "Titan Forge", lots: ["LOT-7731", "LOT-7732"]}
  apex-aero: {name: "Apex Aerostructures", lots: ["LOT-7840", "LOT-7901"]}
  nordic-precision: {name: "Nordic Precision", lots: ["LOT-8002", "LOT-8003"]}

operators: [op-garcia, op-mueller, op-tanaka, op-singh, op-johansson]
cells: [cell-3, cell-4, cell-5]
machines:
  cnc-mill-3: {cell: cell-3, metrics: [spindle_vibration_mm_s, oee_percent]}
  cnc-mill-4: {cell: cell-3, metrics: [spindle_vibration_mm_s, oee_percent]}
  lathe-1: {cell: cell-4, metrics: [temperature_c, oee_percent]}
  drill-press-1: {cell: cell-4, metrics: [cycle_time_ms, oee_percent]}
  drill-press-2: {cell: cell-4, metrics: [cycle_time_ms, oee_percent]}

operations: [
  {num: "Op-40", name: "Rough Machine"},
  {num: "Op-50", name: "Finish Machine"},
  {num: "Op-60", name: "Deburr"},
  {num: "Op-70", name: "Inspect"},
  {num: "Op-80", name: "Surface Treat"}
]

cert_types: [MATERIAL_CERT, PROCESS_CERT, NDT_CERT, HEAT_TREAT_CERT]
test_types: [DIMENSIONAL, NDT_UT, NDT_FPI, HARDNESS, SURFACE_ROUGHNESS]
defect_codes: [BORE_DIAMETER_OOT, SURFACE_FINISH_OOT, POSITION_OOT, CRACK_DETECTED, MATERIAL_INCLUSION]
milestones: [CDR, PDR, FAI-Complete, First-Flight, Type-Cert]
locations: [STAGE-A1, STAGE-A2, STAGE-B1, STAGE-B2, STAGE-C1]

fleet_parameters:
  - {name: hydraulic_pressure_psi, low: 2800, high: 3200, unit: psi}
  - {name: cabin_pressure_diff_psi, low: 8.0, high: 9.0, unit: psi}
  - {name: engine_vibration_ips, low: 0.1, high: 0.8, unit: ips}
  - {name: fuel_flow_pph, low: 800, high: 1200, unit: pph}
```

### DynamoDB Table Schemas

#### PLM (table: plm-demo)

**Part Release:**
```json
{
  "PK": "PART#44821-003", "SK": "VERSION#C",
  "partNumber": "44821-003", "description": "Wing box bore fitting",
  "revision": "C", "status": "RELEASED",
  "releasedBy": "<author>", "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>"
}
```

**Drawing Release:**
```json
{
  "PK": "DRAWING#DWG-44821-003-001", "SK": "REV#C",
  "drawingNumber": "DWG-44821-003-001", "partNumber": "44821-003",
  "revisionLetter": "C", "status": "RELEASED",
  "releasedBy": "<author>", "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>"
}
```

**ECO:**
```json
{
  "PK": "ECO#ECO-90001", "SK": "METADATA",
  "ecoId": "ECO-90001", "partNumber": "44821-003",
  "description": "Update tolerance on 44821-003",
  "status": "INITIATED", "initiatedBy": "<author>",
  "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>"
}
```

#### ERP (table: erp-demo)

**Purchase Order:**
```json
{
  "PK": "PO#PO-90001", "SK": "METADATA",
  "poNumber": "PO-90001", "supplierId": "titan-forge", "supplierName": "Titan Forge",
  "partNumber": "44821-003", "quantity": 50, "unitCost": 250.00,
  "status": "ISSUED", "promisedDate": "2026-04-15",
  "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>", "lastModifiedBy": "<author>"
}
```

**Material Receipt:**
```json
{
  "PK": "RECEIPT#RCPT-90001", "SK": "METADATA",
  "receiptId": "RCPT-90001", "supplierId": "titan-forge", "supplierName": "Titan Forge",
  "partNumber": "44821-003", "lotNumber": "LOT-7731",
  "receiptQuantity": 50, "inspectionRequired": true, "onTime": true,
  "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>", "lastModifiedBy": "<author>"
}
```

#### MES (table: mes-demo)

**Work Order (new/hold):**
```json
{
  "PK": "WO#WO-90001", "SK": "METADATA",
  "workOrderId": "WO-90001", "partNumber": "44821-003", "serialNumber": "SN-0047",
  "status": "STARTED|COMPLETED|HOLD", "cell": "cell-3",
  "operationNumber": "Op-40", "operationName": "Rough Machine",
  "assignedOperator": "op-garcia", "scheduledStart": "<ISO8601>",
  "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>", "lastModifiedBy": "<author>"
}
```
- For HOLD: add `"holdReason": "NCR pending disposition"` and `"holdPlacedBy": "<author>"`

**Operation Complete:**
```json
{
  "PK": "WO#WO-90001", "SK": "OP#Op-40",
  "workOrderId": "WO-90001", "operationNumber": "Op-40", "operationName": "Rough Machine",
  "status": "COMPLETE", "cell": "cell-3", "assignedOperator": "op-garcia",
  "cycleTimeMs": 320000, "actualEnd": "<ISO8601>",
  "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>", "lastModifiedBy": "<author>"
}
```

#### WMS (table: wms-demo)

```json
{
  "PK": "KIT#KIT-90001", "SK": "METADATA",
  "kitId": "KIT-90001", "workOrderId": "WO-90001", "partNumber": "44821-003",
  "status": "STAGED|SHORT", "shortage": false,
  "requiredQty": 10, "stagedQty": 10,
  "locationId": "STAGE-A1", "lotNumber": "LOT-7731",
  "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>", "lastModifiedBy": "<author>"
}
```
- For SHORT: `"shortage": true`, `"stagedQty"` < `"requiredQty"`

#### QMS (table: qms-demo)

```json
{
  "PK": "NCR#NCR-90001", "SK": "METADATA",
  "ncrId": "NCR-90001", "partNumber": "44821-003", "serialNumber": "SN-0047",
  "workOrderId": "WO-90001", "operationNumber": "Op-50",
  "defectCode": "BORE_DIAMETER_OOT", "severity": "MINOR|MAJOR|CRITICAL",
  "supplierId": "titan-forge", "supplierName": "Titan Forge",
  "lotNumber": "LOT-7731", "status": "OPEN",
  "raisedBy": "<author>", "correlationId": "<uuid>",
  "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>"
}
```

#### SRM (table: srm-demo)

```json
{
  "PK": "SUPPLIER#titan-forge", "SK": "SCORE#2026-03",
  "supplierId": "titan-forge", "supplierName": "Titan Forge",
  "qualificationStatus": "QUALIFIED|CONDITIONAL|SUSPENDED",
  "otdPercent": "91.5", "qualityScore": "94.2", "overallScore": "92.8",
  "ncrCount": 1, "deliveryCount": 15, "period": "2026-03",
  "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>", "lastModifiedBy": "<author>"
}
```

#### DHR (table: dhr-demo)

**Operation Sign-off:**
```json
{
  "PK": "SN#SN-0047", "SK": "OP#Op-40#<epoch>",
  "serialNumber": "SN-0047", "partNumber": "44821-003",
  "operationNumber": "Op-40", "status": "SIGNED",
  "completedBy": "op-garcia", "signedBy": "op-garcia",
  "completedAt": "<ISO8601>", "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>"
}
```

**Certificate Link:**
```json
{
  "PK": "SN#SN-0047", "SK": "CERT#MATERIAL_CERT#CERT-90001",
  "serialNumber": "SN-0047", "certType": "MATERIAL_CERT", "certNumber": "CERT-90001",
  "linked": true, "issueDate": "<ISO8601>",
  "partNumber": "44821-003", "lotNumber": "LOT-7731",
  "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>"
}
```
Note: partNumber and lotNumber enable graph edges: Certificate→Part (CERTIFIES_PART), Certificate→Lot (CERTIFIES_LOT)

**Test Record:**
```json
{
  "PK": "SN#SN-0047", "SK": "TEST#TEST-90001",
  "serialNumber": "SN-0047", "testId": "TEST-90001", "testType": "DIMENSIONAL",
  "result": "PASS|FAIL|CONDITIONAL", "recordedBy": "op-garcia",
  "partNumber": "44821-003", "workOrderId": "WO-80001",
  "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>"
}
```
Note: partNumber and workOrderId enable graph edges: TestRecord→Part (TESTS_PART), TestRecord→WorkOrder (TESTED_AT)

#### Program (table: program-demo)

**Milestone:**
```json
{
  "PK": "PROGRAM#ARES-1", "SK": "MILESTONE#FAI-Complete#<epoch>",
  "programId": "ARES-1", "milestoneId": "FAI-Complete",
  "milestoneName": "FAI Complete",
  "plannedDate": "2026-09-15", "forecastDate": "2026-09-20",
  "confidence": 92, "status": "ON_TRACK|AT_RISK",
  "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>", "lastModifiedBy": "<author>"
}
```

**Earned Value:**
```json
{
  "PK": "PROGRAM#ARES-1", "SK": "EV#2026-03#<epoch>",
  "programId": "ARES-1", "period": "2026-03",
  "spi": 1.02, "cpi": 1.01,
  "bcwp": 1050000, "bcws": 1000000, "acwp": 1020000,
  "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>", "lastModifiedBy": "<author>"
}
```

#### InService (table: inservice-demo)

```json
{
  "PK": "DT#SN-0047", "SK": "READING#<epoch>#hydraulic_pressure_psi",
  "serialNumber": "SN-0047", "parameter": "hydraulic_pressure_psi",
  "expectedValue": 3000, "actualValue": 3050.5, "deviation": 1.7, "unit": "psi",
  "status": "NORMAL|ANOMALY", "flightHours": 4500,
  "createdAt": "<ISO8601>", "updatedAt": "<ISO8601>", "lastModifiedBy": "<author>"
}
```

### Smooth vs Drama Status Values

| Domain | Smooth | Drama |
|--------|--------|-------|
| QMS | severity=MINOR | severity=MAJOR or CRITICAL |
| MES | status=STARTED or COMPLETE | status=HOLD |
| ERP | onTime=true | onTime=false |
| WMS | status=STAGED, shortage=false | status=SHORT, shortage=true |
| DHR | result=PASS | result=FAIL or CONDITIONAL |
| SRM | qualificationStatus=QUALIFIED | CONDITIONAL or SUSPENDED |
| Program | status=ON_TRACK, confidence>=70 | status=AT_RISK, confidence<70 |
| InService | status=NORMAL | status=ANOMALY |

## Constraints (Global)
- You MUST use only the entity IDs and constants defined above
- You MUST NOT invent new part numbers, suppliers, operators, or machines
- You MUST ensure every `<ISO8601>` timestamp follows format `2026-MM-DDThh:mm:ss.000Z`
- You MUST ensure `unitCost`, `spi`, `cpi`, `bcwp`, `bcws`, `acwp`, `expectedValue`, `actualValue`, `deviation` are numbers (not strings) in the JSONL
- You MUST ensure `otdPercent`, `qualityScore`, `overallScore` are strings (matching generator format)
- You MUST use `correlationId` (UUID v4) to link related events in the same cascade
- You MUST generate valid JSON on each line — no trailing commas, no comments
- You MUST sort output by t_sec ascending
