"""PLM generator — parts, drawings, the engineering-change workflow, and BOMs.

Models what a product-lifecycle platform emits (vendor-neutral, demo-sized):
  - Parts / drawings with a maturity model: IN_WORK → UNDER_REVIEW → RELEASED → OBSOLETE
  - Engineering change chain: ChangeRequest (ECR) → EngineeringChangeOrder (ECO,
    INITIATED → IN_WORK → APPROVED → RELEASED) → ChangeNotice (ECN, effectivity)
  - BOM revisions (emits BOM_REVISED — consumed by the Change Impact agent)

eventType derives from <PK_PREFIX>_<STATUS> with overrides for ECR#/ECN# (long-form
names). PART#/DRAWING# maturity transitions and ECO_*/BOM_REVISED derive directly.
"""

import os
import time
import random
import logging

import boto3
from boto3.dynamodb.conditions import Attr

from generators.drawing import render_drawing

logger = logging.getLogger(__name__)

# Where released drawings (unstructured artifacts) are stored. The DRAWING_RELEASED
# event carries the key; the graph node, the dashboard viewer, and the read_drawing
# agent tool all resolve the artifact from it.
DRAWINGS_BUCKET = os.environ.get('DRAWINGS_BUCKET', '')
REGION = os.environ.get('AWS_REGION', 'eu-west-1')
_s3 = None

PARTS = {
    '44821-003': {'desc': 'Wing box bore fitting', 'dwg': 'DWG-44821-003-001', 'rev': 'C',
                  'bore': (25.00, 0.02, 0.00)},   # nominal Ø, +tol, -tol (the defect part)
    '44821-007': {'desc': 'Spar cap bracket', 'dwg': 'DWG-44821-007-001', 'rev': 'B',
                  'bore': (16.00, 0.03, 0.00)},
    '44821-012': {'desc': 'Rib attachment lug', 'dwg': 'DWG-44821-012-001', 'rev': 'C',
                  'bore': (12.00, 0.02, 0.00)},
    '55192-001': {'desc': 'Structural bracket assy', 'dwg': 'DWG-55192-001-001', 'rev': 'A',
                  'bore': (20.00, 0.05, 0.00)},
    '55192-004': {'desc': 'Shear tie clip', 'dwg': 'DWG-55192-004-001', 'rev': 'B',
                  'bore': (10.00, 0.03, 0.00)},
}
PART_NUMBERS = list(PARTS.keys())


def _drawing_key(pn: str, dwg: str, rev: str) -> str:
    return f'drawings/{pn}/{dwg}-{rev}.png'


def _store_drawing(pn: str, info: dict) -> dict:
    """Render the drawing to PNG, upload to S3, return the reference fields for the
    DRAWING# item. Returns {} if no bucket is configured (the event still flows)."""
    if not DRAWINGS_BUCKET:
        return {}
    global _s3
    if _s3 is None:
        _s3 = boto3.client('s3', region_name=REGION)
    key = _drawing_key(pn, info['dwg'], info['rev'])
    try:
        bore_nominal, tol_up, tol_lo = info['bore']
        png = render_drawing(pn, info['dwg'], info['rev'], title=info['desc'].upper(),
                             bore_nominal=bore_nominal, tol_up=tol_up, tol_lo=tol_lo)
        _s3.put_object(Bucket=DRAWINGS_BUCKET, Key=key, Body=png, ContentType='image/png')
        logger.info('gen_plm: stored drawing s3://%s/%s (%d bytes)', DRAWINGS_BUCKET, key, len(png))
        return {
            'drawingS3Bucket': DRAWINGS_BUCKET,
            'drawingS3Key': key,
            'drawingUri': f's3://{DRAWINGS_BUCKET}/{key}',
            'drawingContentType': 'image/png',
        }
    except Exception as e:
        logger.warning('gen_plm: drawing render/upload failed for %s: %s', pn, e)
        return {}

# Vendor-neutral lifecycle / maturity vocabulary.
MATURITY_STATES = ['IN_WORK', 'UNDER_REVIEW', 'RELEASED', 'OBSOLETE']
DESIGNERS = ['eng-novak', 'eng-bianchi', 'eng-okafor']
CHANGE_REASONS = [
    'Tolerance tightening on critical feature',
    'Material substitution per supplier change',
    'Fit interference resolution',
    'Weight reduction',
]


def _now() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())


async def run(dynamodb, state: dict, density: float = 1.0) -> None:
    phase = state.get('phase', '')
    if phase not in ('PRODUCTION', 'QA', 'DESIGN'):
        return
    if random.random() > 0.25 * density:
        return

    table = dynamodb.Table('plm-demo')
    now = _now()

    # Weighted across the PLM workload — releases/drawings common, the full change
    # chain (ECR→ECO→ECN) and BOM revisions less frequent but high-signal.
    action = random.choices(
        ['part_release', 'drawing', 'change_request', 'eco', 'change_notice', 'bom_revise'],
        weights=[4, 4, 2, 3, 1, 2],
    )[0]

    try:
        if action == 'part_release':
            pn = random.choice(PART_NUMBERS)
            info = PARTS[pn]
            # Maturity transition — bias toward RELEASED but show the lifecycle.
            maturity = random.choices(MATURITY_STATES, weights=[2, 2, 5, 1])[0]
            table.put_item(Item={
                'PK': f'PART#{pn}', 'SK': f'VERSION#{info["rev"]}',
                'partNumber': pn, 'description': info['desc'],
                'revision': info['rev'],
                'status': maturity, 'maturityState': maturity,
                'lifecycleState': maturity,
                'effectivity': 'S/N 0048-onward',
                'releasedBy': random.choice(DESIGNERS),
                'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-plm',
            })  # no condition — maturity transitions update the same version
            logger.info('gen_plm: part %s rev %s → %s', pn, info['rev'], maturity)

        elif action == 'drawing':
            pn = random.choice(PART_NUMBERS)
            info = PARTS[pn]
            maturity = random.choices(MATURITY_STATES, weights=[2, 2, 5, 1])[0]
            # On RELEASED, render the actual 2D drawing and store it as an unstructured
            # artifact in S3; the reference fields ride through to DRAWING_RELEASED.
            drawing_ref = _store_drawing(pn, info) if maturity == 'RELEASED' else {}
            table.put_item(Item={
                'PK': f'DRAWING#{info["dwg"]}', 'SK': f'REV#{info["rev"]}',
                'drawingNumber': info['dwg'], 'partNumber': pn,
                'revisionLetter': info['rev'],
                **drawing_ref,
                'status': maturity, 'maturityState': maturity,
                'releasedBy': random.choice(DESIGNERS),
                'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-plm',
            })
            logger.info('gen_plm: drawing %s rev %s → %s', info['dwg'], info['rev'], maturity)

        elif action == 'change_request':
            ecr = f'ECR-{random.randint(2000, 2999)}'
            pn = random.choice(PART_NUMBERS)
            status = random.choices(['SUBMITTED', 'EVALUATED'], weights=[5, 5])[0]
            table.put_item(Item={
                'PK': f'ECR#{ecr}', 'SK': 'METADATA',
                'ecrId': ecr, 'partNumber': pn,
                'reason': random.choice(CHANGE_REASONS),
                'requestedBy': random.choice(DESIGNERS),
                'status': status,
                'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-plm',
            }, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_plm: change request %s %s — %s', ecr, status, pn)

        elif action == 'eco':
            eco_id = f'ECO-{random.randint(1000, 9999)}'
            pn = random.choice(PART_NUMBERS)
            # ECO lifecycle — bias toward earlier states; RELEASED is the high-signal one.
            status = random.choices(
                ['INITIATED', 'IN_WORK', 'APPROVED', 'RELEASED'],
                weights=[4, 3, 2, 2],
            )[0]
            eco_item = {
                'PK': f'ECO#{eco_id}', 'SK': 'METADATA',
                'ecoId': eco_id, 'partNumber': pn,
                'description': f'Update tolerance on {pn}',
                'reason': random.choice(CHANGE_REASONS),
                'ecrId': f'ECR-{random.randint(2000, 2999)}',
                'effectivity': 'S/N 0048-onward',
                'status': status,
                'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-plm',
            }
            if status in ('APPROVED', 'RELEASED'):
                eco_item['approvedBy'] = random.choice(DESIGNERS)
            table.put_item(Item=eco_item)  # no condition — ECO transitions on the same PK
            logger.info('gen_plm: ECO %s → %s', eco_id, status)

        elif action == 'change_notice':
            ecn = f'ECN-{random.randint(3000, 3999)}'
            pn = random.choice(PART_NUMBERS)
            info = PARTS[pn]
            table.put_item(Item={
                'PK': f'ECN#{ecn}', 'SK': 'METADATA',
                'ecnId': ecn, 'partNumber': pn,
                'ecoId': f'ECO-{random.randint(1000, 9999)}',
                'newRevision': chr(ord(info['rev']) + 1),
                'effectivity': 'S/N 0048-onward',
                'status': 'ISSUED', 'issuedBy': random.choice(DESIGNERS),
                'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-plm',
            }, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_plm: change notice %s ISSUED — %s', ecn, pn)

        elif action == 'bom_revise':
            bom_id = f'BOM-{random.randint(5000, 5999)}'
            parent = random.choice(['55192-001'])  # the assembly part
            child = random.choice(['44821-003', '44821-007', '44821-012'])
            table.put_item(Item={
                'PK': f'BOM#{bom_id}', 'SK': 'METADATA',
                'bomId': bom_id, 'parentPart': parent,
                'partNumber': parent,
                'changedComponents': [child],
                'revision': random.choice(['B', 'C', 'D']),
                'reason': random.choice(CHANGE_REASONS),
                'status': 'REVISED',
                'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-plm',
            }, ConditionExpression=Attr('PK').not_exists())
            logger.info('gen_plm: BOM %s REVISED — %s adds %s', bom_id, parent, child)

    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        logger.debug('gen_plm: duplicate — skipping')
