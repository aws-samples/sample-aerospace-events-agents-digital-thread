#!/usr/bin/env python3
"""
Seed Baseline — generates 90 days of historical aerospace events by writing
to DynamoDB tables. Events flow through the full pipeline:
DDB Stream → Lambda Producer → MSK → Fast Consumer (Neptune) + Firehose (Iceberg/Athena)

Seeds in dependency order so graph relationships build correctly.

Usage:
  export AWS_PROFILE=your-aws-profile AWS_REGION=eu-west-1
  python3 scripts/seed-baseline.py
"""

import os
import random
import time
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import boto3

REGION = 'eu-west-1'
dynamodb = boto3.resource('dynamodb', region_name=REGION)
ACCOUNT_ID = boto3.client('sts', region_name=REGION).get_caller_identity()['Account']

# Deterministic seed → identical baseline (same SEED-* ids, same graph) every run.
random.seed(20260601)

# Committed PLM drawings are deployed to the datalake by StorageStack's
# BucketDeployment, so this Lambda only needs to write DRAWING# records that point
# at them (drawings/{partNumber}/{drawingNumber}-{rev}.png). Same refs as the CLI seed.
DATALAKE_BUCKET = os.environ.get(
    'DATALAKE_BUCKET', f'aerospace-datalake-{REGION}-{ACCOUNT_ID}')
# partNumber → list of revisions (drawingNumber, rev, boreTolUpper, maturity).
# 44821-003 carries its A→B→C history: the bore tolerance is tightened at rev C
# (+0.05 → +0.02 H7), the reason a Ø25.04 bore is out-of-tolerance. PNGs are deployed
# to S3 by StorageStack; this Lambda only writes the DRAWING# records.
SEED_DRAWINGS = {
    '44821-003': [
        ('DWG-44821-003-001', 'A', 0.05, 'SUPERSEDED'),
        ('DWG-44821-003-001', 'B', 0.05, 'SUPERSEDED'),
        ('DWG-44821-003-001', 'C', 0.02, 'RELEASED'),
    ],
    '44821-007': [('DWG-44821-007-001', 'B', 0.03, 'RELEASED')],
    '44821-012': [('DWG-44821-012-001', 'C', 0.02, 'RELEASED')],
    '55192-001': [('DWG-55192-001-001', 'A', 0.05, 'RELEASED')],
    '55192-004': [('DWG-55192-004-001', 'B', 0.03, 'RELEASED')],
}

# ─── Shared Constants ───────────────────────────────────────────────

DAYS = 90
PART_NUMBERS = ['44821-003', '44821-007', '44821-012', '55192-001', '55192-004']
PART_DESCRIPTIONS = {
    '44821-003': 'Wing rib bracket - flight critical bore',
    '44821-007': 'Wing rib bracket - standard',
    '44821-012': 'Wing rib bracket - outboard',
    '55192-001': 'Structural bracket - main spar',
    '55192-004': 'Structural bracket - auxiliary',
}
SUPPLIERS = [('titan-forge', 'Titan Forge'), ('apex-aero', 'Apex Aerostructures'), ('nordic-precision', 'Nordic Precision')]
DEFECT_CODES = ['BORE_DIAMETER_OOT', 'SURFACE_FINISH_OOT', 'POSITION_OOT', 'CRACK_DETECTED', 'MATERIAL_INCLUSION']
OPERATIONS = [('Op-40', 'Rough Machine'), ('Op-50', 'Finish Machine'), ('Op-60', 'Deburr'), ('Op-70', 'Inspect'), ('Op-80', 'Surface Treat')]
CELLS = ['cell-3', 'cell-4', 'cell-5']
OPERATORS = ['op-garcia', 'op-mueller', 'op-tanaka', 'op-singh', 'op-johansson']
MILESTONES = ['CDR', 'PDR', 'FAI-Complete', 'First-Flight', 'Type-Cert']
FLEET_SNS = ['SN-0038', 'SN-0039', 'SN-0041', 'SN-0044', 'SN-0047']
CERT_TYPES = ['MATERIAL_CERT', 'PROCESS_CERT', 'NDT_CERT', 'HEAT_TREAT_CERT']
TEST_TYPES = ['DIMENSIONAL', 'NDT_UT', 'NDT_FPI', 'HARDNESS', 'SURFACE_ROUGHNESS']

total_ddb = 0


def ts(dt: datetime) -> str:
    return dt.strftime('%Y-%m-%dT%H:%M:%S.000Z')


def write_ddb(table_name: str, items: list):
    global total_ddb
    table = dynamodb.Table(table_name)
    with table.batch_writer() as writer:
        for item in items:
            clean = {}
            for k, v in item.items():
                if isinstance(v, float):
                    clean[k] = Decimal(str(round(v, 2)))
                else:
                    clean[k] = v
            # Ensure ALL seed items are tagged — agents check this to skip seed data
            clean['lastModifiedBy'] = 'seed-baseline'
            writer.put_item(Item=clean)
    total_ddb += len(items)


# ─── PLM (Parts, Drawings, ECOs) ────────────────────────────────────

def generate_plm_history(start: datetime, end: datetime) -> list:
    items = []
    now_ts = ts(start)

    # Release all 5 parts with revisions
    for pn in PART_NUMBERS:
        for rev in ['A', 'B']:
            items.append({
                'PK': f'PART#{pn}', 'SK': f'VERSION#{rev}',
                'partNumber': pn, 'description': PART_DESCRIPTIONS.get(pn, ''),
                'revision': rev, 'status': 'RELEASED',
                'releasedBy': 'seed-baseline',
                'createdAt': now_ts, 'updatedAt': now_ts,
            })
        # Drawing revisions for each part — each references its committed PNG artifact
        # (deployed to S3 by StorageStack). 44821-003 carries 3 revs (A/B/C) showing
        # the bore-tolerance tightening that makes a Ø25.04 bore out-of-tolerance.
        for dwg, rev, bore_tol_up, maturity in SEED_DRAWINGS[pn]:
            key = f'drawings/{pn}/{dwg}-{rev}.png'
            items.append({
                'PK': f'DRAWING#{dwg}', 'SK': f'REV#{rev}',
                'drawingNumber': dwg, 'partNumber': pn,
                'revisionLetter': rev, 'status': maturity, 'maturityState': maturity,
                'boreNominalMm': Decimal('25.00') if pn == '44821-003' else None,
                'boreToleranceUpperMm': Decimal(str(bore_tol_up)),
                'effectivity': 'S/N 0048-onward' if maturity == 'RELEASED' else 'superseded',
                'drawingS3Bucket': DATALAKE_BUCKET, 'drawingS3Key': key,
                'drawingUri': f's3://{DATALAKE_BUCKET}/{key}', 'drawingContentType': 'image/png',
                'releasedBy': 'seed-baseline',
                'createdAt': now_ts, 'updatedAt': now_ts,
            })

    # Engineering-change workflow over the period: ECR → ECO → ECN, plus BOM revisions.
    current = start + timedelta(days=30)
    for i in range(5):
        pn = random.choice(PART_NUMBERS)
        ecr = f'ECR-SEED-{i+1}'
        eco = f'ECO-SEED-{i+1}'
        items.append({
            'PK': f'ECR#{ecr}', 'SK': 'METADATA',
            'ecrId': ecr, 'partNumber': pn,
            'reason': f'Tolerance tightening on {pn}',
            'status': 'EVALUATED', 'requestedBy': 'seed-baseline',
            'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
        })
        items.append({
            'PK': f'ECO#{eco}', 'SK': 'METADATA',
            'ecoId': eco, 'partNumber': pn, 'ecrId': ecr,
            'description': f'Update tolerance on {pn}',
            'effectivity': 'S/N 0048-onward',
            'status': 'RELEASED', 'approvedBy': 'seed-baseline',
            'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
        })
        ecn = f'ECN-SEED-{i+1}'
        items.append({
            'PK': f'ECN#{ecn}', 'SK': 'METADATA',
            'ecnId': ecn, 'partNumber': pn, 'ecoId': eco,
            'newRevision': 'C', 'effectivity': 'S/N 0048-onward',
            'status': 'ISSUED', 'issuedBy': 'seed-baseline',
            'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
        })
        current += timedelta(days=12)

    # (change notice cuts the new revision in — emitted per ECO above)

    # A couple of BOM revisions on the assembly.
    for i in range(2):
        bom = f'BOM-SEED-{i+1}'
        items.append({
            'PK': f'BOM#{bom}', 'SK': 'METADATA',
            'bomId': bom, 'parentPart': '55192-001', 'partNumber': '55192-001',
            'changedComponents': [random.choice(['44821-003', '44821-007'])],
            'revision': random.choice(['B', 'C']),
            'reason': 'Component substitution', 'status': 'REVISED',
            'createdAt': now_ts, 'updatedAt': now_ts, 'lastModifiedBy': 'seed-baseline',
        })

    return items


# ─── ERP (Purchase Orders + Material Receipts) ──────────────────────

def generate_erp_history(start: datetime, end: datetime) -> list:
    items = []
    current = start

    while current < end:
        if random.random() < 0.3:
            supplier_id, supplier_name = random.choice(SUPPLIERS)
            pn = random.choice(PART_NUMBERS)
            plant = random.choice(['MRD', 'ASH'])
            qty = random.choice([10, 25, 50, 100])

            # Requisition → PO (approved requisition precedes the order)
            pr = f'PR-SEED-{random.randint(10000, 39999)}'
            items.append({
                'PK': f'PR#{pr}', 'SK': 'METADATA',
                'requisitionId': pr, 'partNumber': pn, 'quantity': qty,
                'requisitioner': 'seed-baseline', 'costCenter': 'CC-4100',
                'purchasingGroup': 'PG-01', 'materialGroup': 'MG-FORGING',
                'plantId': plant, 'status': 'APPROVED',
                'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
            })

            po = f'PO-SEED-{random.randint(10000, 49999)}'
            items.append({
                'PK': f'PO#{po}', 'SK': 'METADATA',
                'poNumber': po, 'supplierId': supplier_id, 'supplierName': supplier_name,
                'partNumber': pn, 'quantity': qty,
                'unitCost': Decimal(str(round(random.uniform(50, 500), 2))),
                'currency': 'EUR', 'incoterms': 'FCA', 'plantId': plant,
                'purchasingGroup': 'PG-01', 'materialGroup': 'MG-FORGING', 'taxCode': 'V0',
                'status': 'CONFIRMED', 'promisedDate': '2026-04-15',
                'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
            })

            # Goods receipt a few days later
            lot = f'LOT-{random.randint(7700, 8100)}'
            rcpt = f'RCPT-SEED-{random.randint(10000, 69999)}'
            receipt_date = current + timedelta(days=random.randint(3, 14))
            inspection_required = random.choice([True, False])
            receipt = {
                'PK': f'RECEIPT#{rcpt}', 'SK': 'METADATA',
                'receiptId': rcpt, 'supplierId': supplier_id, 'supplierName': supplier_name,
                'partNumber': pn, 'lotNumber': lot,
                'receiptQuantity': random.choice([10, 25, 50]),
                'movementType': 'GR-101', 'plantId': plant, 'storageLocation': 'SL-RAW',
                'inspectionRequired': inspection_required,
                'onTime': random.random() > 0.2,
                'createdAt': ts(receipt_date), 'updatedAt': ts(receipt_date), 'lastModifiedBy': 'seed-baseline',
            }
            if inspection_required:
                receipt['inspectionLotId'] = f'INSP-{random.randint(50000, 59999)}'
            items.append(receipt)

            # Supplier invoice (3-way match) — mostly matched in the baseline
            inv = f'INV-SEED-{random.randint(10000, 89999)}'
            invoice_date = receipt_date + timedelta(days=random.randint(1, 7))
            items.append({
                'PK': f'INV#{inv}', 'SK': 'METADATA',
                'invoiceId': inv, 'supplierId': supplier_id, 'supplierName': supplier_name,
                'partNumber': pn,
                'invoiceAmount': Decimal(str(round(random.uniform(500, 25000), 2))),
                'currency': 'EUR', 'taxCode': 'V0', 'matchType': '3-way',
                'status': 'MATCHED',
                'createdAt': ts(invoice_date), 'updatedAt': ts(invoice_date), 'lastModifiedBy': 'seed-baseline',
            })

        current += timedelta(days=1)
    return items


# ─── MES (Work Orders) ──────────────────────────────────────────────

def generate_mes_history(start: datetime, end: datetime) -> list:
    items = []
    current = start

    while current < end:
        for _ in range(random.randint(3, 8)):
            wo_id = f'WO-SEED-{random.randint(10000, 99999)}'
            pn = random.choice(PART_NUMBERS)
            op_num, op_name = random.choice(OPERATIONS)
            cell = random.choice(CELLS)
            status = random.choice(['STARTED', 'COMPLETED', 'HOLD'])

            item = {
                'PK': f'WO#{wo_id}', 'SK': 'METADATA',
                'workOrderId': wo_id, 'partNumber': pn, 'serialNumber': 'SN-0047',
                'status': status, 'cell': cell,
                'operationNumber': op_num, 'operationName': op_name,
                'assignedOperator': random.choice(OPERATORS),
                'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
            }
            if status == 'HOLD':
                item['holdReason'] = random.choice(['NCR pending disposition', 'Material traceability review', 'Tooling calibration due'])
            items.append(item)

        current += timedelta(days=1)
    return items


# ─── WMS (Kit Staging) ──────────────────────────────────────────────

def generate_wms_history(start: datetime, end: datetime) -> list:
    items = []
    current = start + timedelta(days=5)  # kits come after WOs

    while current < end:
        if random.random() < 0.4:
            kit_id = f'KIT-SEED-{random.randint(10000, 19999)}'
            wo_id = f'WO-SEED-{random.randint(10000, 99999)}'
            pn = random.choice(PART_NUMBERS)
            lot = f'LOT-{random.randint(7700, 8100)}'
            is_short = random.random() < 0.15

            items.append({
                'PK': f'KIT#{kit_id}', 'SK': 'METADATA',
                'kitId': kit_id, 'workOrderId': wo_id, 'partNumber': pn,
                'status': 'SHORT' if is_short else 'STAGED',
                'shortage': is_short,
                'requiredQty': 10, 'stagedQty': 7 if is_short else 10,
                'locationId': random.choice(['STAGE-A1', 'STAGE-A2', 'STAGE-B1']),
                'lotNumber': lot,
                'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
            })
        current += timedelta(days=1)
    return items


# ─── QMS (NCRs) ─────────────────────────────────────────────────────

def generate_qms_history(start: datetime, end: datetime) -> list:
    items = []
    current = start
    ncr_count = 0

    while current < end:
        for _ in range(random.randint(2, 5)):
            ncr_id = f'NCR-SEED-{int(current.timestamp())}-{ncr_count}'
            supplier_id, supplier_name = random.choice(SUPPLIERS)
            severity = random.choices(['MINOR', 'MAJOR', 'CRITICAL'], weights=[6, 3, 1])[0]
            pn = random.choice(PART_NUMBERS)
            lot = f'LOT-{random.randint(7700, 8100)}'

            items.append({
                'PK': f'NCR#{ncr_id}', 'SK': 'METADATA',
                'ncrId': ncr_id, 'partNumber': pn, 'serialNumber': 'SN-0047',
                'defectCode': random.choice(DEFECT_CODES), 'severity': severity,
                'supplierId': supplier_id, 'supplierName': supplier_name,
                'lotNumber': lot,
                'status': random.choice(['OPEN', 'DISPOSITIONED', 'CLOSED']),
                'raisedBy': 'seed-baseline', 'lastModifiedBy': 'seed-baseline',
                'createdAt': ts(current), 'updatedAt': ts(current),
            })
            ncr_count += 1
            current += timedelta(hours=random.uniform(2, 8))

        current = current.replace(hour=0) + timedelta(days=1)
    return items


# ─── SRM (Supplier Scores) ──────────────────────────────────────────

def generate_srm_history(start: datetime, end: datetime) -> list:
    items = []
    current = start

    while current < end:
        if current.day in (1, 15):
            for sid, sname in SUPPLIERS:
                otd = round(random.uniform(60, 98), 1)
                quality = round(random.uniform(70, 99), 1)
                overall = round((otd + quality) / 2, 1)
                period = current.strftime('%Y-%m')
                items.append({
                    'PK': f'SUPPLIER#{sid}', 'SK': f'SCORE#{period}#{current.day}',
                    'supplierId': sid, 'supplierName': sname,
                    'otdPercent': str(otd), 'qualityScore': str(quality), 'overallScore': str(overall),
                    'qualificationStatus': 'QUALIFIED' if overall >= 80 else 'CONDITIONAL',
                    'period': period,
                    'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
                })
        current += timedelta(days=1)
    return items


# ─── DHR (Certs, Tests, Op Signoffs) ────────────────────────────────

def generate_dhr_history(start: datetime, end: datetime) -> list:
    items = []
    current = start

    while current < end:
        sn = 'SN-0047'
        pn = random.choice(PART_NUMBERS)

        # Op signoffs (several per week)
        if random.random() < 0.5:
            op_num, _ = random.choice(OPERATIONS)
            operator = random.choice(OPERATORS)
            items.append({
                'PK': f'SN#{sn}', 'SK': f'OP#{op_num}#{int(current.timestamp())}',
                'serialNumber': sn, 'partNumber': pn,
                'operationNumber': op_num, 'status': 'SIGNED',
                'completedBy': operator, 'signedBy': operator,
                'completedAt': ts(current),
                'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
            })

        # Cert links (weekly)
        if current.weekday() == 2 and random.random() < 0.6:
            cert_type = random.choice(CERT_TYPES)
            cert_num = f'CERT-SEED-{random.randint(1000, 9999)}'
            items.append({
                'PK': f'SN#{sn}', 'SK': f'CERT#{cert_type}#{cert_num}',
                'serialNumber': sn, 'certType': cert_type, 'certNumber': cert_num,
                'linked': True, 'issueDate': ts(current),
                'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
            })

        # Test records (weekly)
        if current.weekday() == 4 and random.random() < 0.5:
            test_type = random.choice(TEST_TYPES)
            test_id = f'TEST-SEED-{random.randint(5000, 5999)}'
            result = random.choices(['PASS', 'FAIL', 'CONDITIONAL'], weights=[80, 10, 10])[0]
            items.append({
                'PK': f'SN#{sn}', 'SK': f'TEST#{test_id}',
                'serialNumber': sn, 'testId': test_id, 'testType': test_type,
                'result': result, 'recordedBy': random.choice(OPERATORS),
                'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
            })

        current += timedelta(days=1)
    return items


# ─── Program (Milestones + EV Metrics) ──────────────────────────────

def generate_program_history(start: datetime, end: datetime) -> list:
    items = []
    current = start

    while current < end:
        if current.weekday() == 0:
            period = current.strftime('%Y-%m')
            spi = round(random.uniform(0.85, 1.1), 2)
            cpi = round(random.uniform(0.88, 1.05), 2)
            items.append({
                'PK': 'PROGRAM#ARES-1', 'SK': f'EV#{period}#{int(current.timestamp())}',
                'programId': 'ARES-1', 'period': period,
                'spi': Decimal(str(spi)), 'cpi': Decimal(str(cpi)),
                'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
            })

        if current.day == 1:
            ms = random.choice(MILESTONES)
            confidence = random.randint(60, 95)
            items.append({
                'PK': 'PROGRAM#ARES-1', 'SK': f'MILESTONE#{ms}#{int(current.timestamp())}',
                'programId': 'ARES-1', 'milestoneId': ms,
                'milestoneName': ms.replace('-', ' '),
                'confidence': confidence, 'status': 'ON_TRACK' if confidence >= 70 else 'AT_RISK',
                'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
            })

        current += timedelta(days=1)
    return items


# ─── InService (Fleet Telemetry) ────────────────────────────────────

def generate_inservice_history(start: datetime, end: datetime) -> list:
    items = []
    current = start
    parameters = [
        ('hydraulic_pressure_psi', 3000, 2800, 3200, 'psi'),
        ('cabin_pressure_diff_psi', 8.5, 8.0, 9.0, 'psi'),
        ('engine_vibration_ips', 0.45, 0.1, 0.8, 'ips'),
        ('fuel_flow_pph', 1000, 800, 1200, 'pph'),
    ]

    while current < end:
        for sn in FLEET_SNS:
            if random.random() < 0.3:  # ~30% chance per day per aircraft
                param, expected, low, high, unit = random.choice(parameters)
                is_anomaly = random.random() < 0.10
                if is_anomaly:
                    actual = round(expected * random.uniform(1.15, 1.35), 2)
                else:
                    actual = round(random.uniform(low, high), 2)
                deviation = round(abs(actual - expected) / ((high - low) / 2) * 100, 1)

                items.append({
                    'PK': f'DT#{sn}', 'SK': f'READING#{int(current.timestamp())}#{param}',
                    'serialNumber': sn, 'parameter': param,
                    'expectedValue': Decimal(str(expected)), 'actualValue': Decimal(str(actual)),
                    'deviation': Decimal(str(deviation)), 'unit': unit,
                    'status': 'ANOMALY' if is_anomaly else 'NORMAL',
                    'flightHours': random.randint(1000, 8000),
                    'createdAt': ts(current), 'updatedAt': ts(current), 'lastModifiedBy': 'seed-baseline',
                })
        current += timedelta(days=1)
    return items


# ─── Main ────────────────────────────────────────────────────────────

TABLE_MAP = {
    'PLM': 'plm-demo',
    'ERP': 'erp-demo',
    'MES': 'mes-demo',
    'WMS': 'wms-demo',
    'QMS': 'qms-demo',
    'SRM': 'srm-demo',
    'DHR': 'dhr-demo',
    'Program': 'program-demo',
    'InService': 'inservice-demo',
}


def main():
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=DAYS)

    print(f'=== Generating {DAYS}-day seed baseline ===')
    print(f'  Period: {start.date()} → {end.date()}')
    print(f'  Seeding in dependency order: PLM → ERP → MES → WMS → QMS → SRM → DHR → Program → InService')

    # Generate in dependency order
    generators = [
        ('PLM', generate_plm_history),
        ('ERP', generate_erp_history),
        ('MES', generate_mes_history),
        ('WMS', generate_wms_history),
        ('QMS', generate_qms_history),
        ('SRM', generate_srm_history),
        ('DHR', generate_dhr_history),
        ('Program', generate_program_history),
        ('InService', generate_inservice_history),
    ]

    for name, gen_fn in generators:
        print(f'\n  Generating {name} history...')
        items = gen_fn(start, end)
        print(f'    {len(items)} DDB items')
        table = TABLE_MAP[name]
        write_ddb(table, items)
        print(f'    → {table}')

    print(f'\n=== Done ===')
    print(f'  Total DDB items: {total_ddb}')
    print(f'  Pipeline: DDB → Stream → Producer → MSK → Neptune + Firehose/Iceberg')
    print(f'  Graph + Athena data available after ~2 min (producer + consumer + Firehose buffer)')


def handler(event, context):
    """Lambda handler — invoked by HITL Lambda."""
    main()
    return {'statusCode': 200, 'body': f'Seeded {total_ddb} items across 9 domains'}


if __name__ == '__main__':
    main()
