"""SRM generator — creates supplier score updates."""

import time
import random
import logging
from boto3.dynamodb.conditions import Attr

logger = logging.getLogger(__name__)

SUPPLIERS = [('titan-forge', 'Titan Forge'), ('apex-aero', 'Apex Aerostructures'), ('nordic-precision', 'Nordic Precision')]


async def run(dynamodb, state: dict, density: float = 1.0) -> None:
    phase = state.get('phase', '')
    if phase not in ('PRODUCTION', 'QA'):
        return
    if random.random() > 0.5 * density:
        return

    table = dynamodb.Table('srm-demo')
    now = time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime())
    period = time.strftime('%Y-%m', time.gmtime())
    supplier_id, supplier_name = random.choice(SUPPLIERS)

    mode = state.get('mode', 'DRAMA')
    if mode == 'SMOOTH':
        otd = round(random.uniform(82, 98), 1)
        quality = round(random.uniform(80, 99), 1)
    else:
        otd = round(random.uniform(60, 98), 1)
        quality = round(random.uniform(70, 99), 1)
    overall = round((otd + quality) / 2, 1)
    qual_status = 'QUALIFIED' if overall >= 80 else ('CONDITIONAL' if overall >= 65 else 'SUSPENDED')

    try:
        table.put_item(Item={
            'PK': f'SUPPLIER#{supplier_id}', 'SK': f'SCORE#{period}',
            'supplierId': supplier_id, 'supplierName': supplier_name,
            'qualificationStatus': qual_status,
            'otdPercent': str(otd), 'qualityScore': str(quality), 'overallScore': str(overall),
            'ncrCount': random.randint(0, 5), 'deliveryCount': random.randint(5, 30),
            'period': period,
            'createdAt': now, 'updatedAt': now, 'lastModifiedBy': 'gen-srm',
        }, ConditionExpression=Attr('PK').not_exists())
        logger.info('gen_srm: score update %s — OTD=%.1f%% Quality=%.1f%% [%s]',
                     supplier_id, otd, quality, qual_status)

    except dynamodb.meta.client.exceptions.ConditionalCheckFailedException:
        logger.debug('gen_srm: %s %s already exists — skipping', supplier_id, period)
