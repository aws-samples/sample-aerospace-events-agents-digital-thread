#!/usr/bin/env python3
"""
Replay failed graph writes from the DLQ table.

Reads entries from graph-write-dlq, re-executes Gremlin queries via the
Neptune query Lambda, and deletes successful replays.

Usage:
  export AWS_PROFILE=your-aws-profile AWS_REGION=eu-west-1
  python3 scripts/replay-dlq.py              # replay all
  python3 scripts/replay-dlq.py --dry-run    # show what would be replayed
"""

import argparse
import json
import os

import boto3

REGION = os.environ.get('AWS_REGION', 'eu-west-1')
DLQ_TABLE = 'graph-write-dlq'

dynamodb = boto3.resource('dynamodb', region_name=REGION)
lam = boto3.client('lambda', region_name=REGION)


def scan_dlq():
    table = dynamodb.Table(DLQ_TABLE)
    items = []
    resp = table.scan()
    items.extend(resp.get('Items', []))
    while resp.get('LastEvaluatedKey'):
        resp = table.scan(ExclusiveStartKey=resp['LastEvaluatedKey'])
        items.extend(resp.get('Items', []))
    return items


def replay_gremlin(gremlin: str) -> tuple[bool, str]:
    """Execute Gremlin via the Neptune query Lambda."""
    payload = json.dumps({
        'body': json.dumps({
            'operation': 'execute_gremlin',
            'parameters': {'gremlin': gremlin},
        })
    })
    resp = lam.invoke(FunctionName='aerospace-neptune-query', Payload=payload.encode())
    body = json.loads(resp['Payload'].read())
    status = body.get('statusCode', 500)
    result = json.loads(body.get('body', '{}'))

    if status == 200:
        return (True, 'OK')
    return (False, result.get('error', f'HTTP {status}'))


def delete_dlq_item(pk: str, sk: str):
    table = dynamodb.Table(DLQ_TABLE)
    table.delete_item(Key={'PK': pk, 'SK': sk})


def main():
    parser = argparse.ArgumentParser(description='Replay failed graph writes')
    parser.add_argument('--dry-run', action='store_true', help='Show entries without replaying')
    args = parser.parse_args()

    print(f'=== Scanning DLQ table: {DLQ_TABLE} ===')
    items = scan_dlq()
    print(f'  {len(items)} failed writes found')

    if not items:
        print('  Nothing to replay.')
        return

    replayed = 0
    failed = 0

    for item in sorted(items, key=lambda x: x.get('failedAt', 0)):
        pk = item.get('PK', '')
        sk = item.get('SK', '')
        node_id = item.get('nodeId', '')
        error = item.get('error', '')[:80]
        gremlin = item.get('gremlin', '')

        print(f'\n  [{sk}] {node_id}')
        print(f'    original error: {error}')

        if args.dry_run:
            print(f'    gremlin: {gremlin[:150]}...')
            continue

        if not gremlin:
            print(f'    SKIP — no gremlin stored')
            failed += 1
            continue

        ok, msg = replay_gremlin(gremlin)
        if ok:
            print(f'    REPLAYED OK')
            delete_dlq_item(pk, sk)
            replayed += 1
        else:
            print(f'    FAILED AGAIN: {msg}')
            failed += 1

    print(f'\n=== Summary ===')
    print(f'  Replayed: {replayed}')
    print(f'  Failed:   {failed}')
    if args.dry_run:
        print(f'  (dry run — nothing replayed)')


if __name__ == '__main__':
    main()
