"""Scenario runner — replays a JSONL event file through DynamoDB.

Two phases:
1. Seed: bulk-write all phase=seed events (fast, batch writer)
2. Live: replay phase=live events at timed intervals (triggers pipeline)
"""

import asyncio
import json
import logging
import os
import time
from decimal import Decimal

logger = logging.getLogger(__name__)

SCENARIO_DIR = os.path.join(os.path.dirname(__file__), '..', 'scenarios')
DEMO_CONTROL_TABLE = os.environ.get('DEMO_CONTROL_TABLE', 'demo-control')


LOCK_STALE_SECONDS = 900  # 15 minutes — treat lock as stale after this


def _is_scenario_running(dynamodb) -> bool:
    """Check if a scenario is already running (persisted in DDB).

    Returns False if the lock is older than LOCK_STALE_SECONDS — handles
    the case where a container is killed mid-replay (ECS rolling deploy)
    and the lock is never cleared.
    """
    try:
        table = dynamodb.Table(DEMO_CONTROL_TABLE)
        resp = table.get_item(Key={'PK': 'DEMO_CLOCK', 'SK': 'SCENARIO_LOCK'})
        item = resp.get('Item', {})
        if not item.get('running', False):
            return False
        started_at = item.get('startedAt', '')
        if started_at:
            import datetime
            started = datetime.datetime.strptime(started_at, '%Y-%m-%dT%H:%M:%S.000Z')
            age = (datetime.datetime.utcnow() - started).total_seconds()
            if age > LOCK_STALE_SECONDS:
                logger.warning('Scenario lock is stale (%.0fs old) — clearing', age)
                table.delete_item(Key={'PK': 'DEMO_CLOCK', 'SK': 'SCENARIO_LOCK'})
                return False
        return True
    except Exception:
        return False


def _set_scenario_lock(dynamodb, running: bool):
    """Set/clear the scenario lock in DDB."""
    try:
        table = dynamodb.Table(DEMO_CONTROL_TABLE)
        if running:
            table.put_item(Item={
                'PK': 'DEMO_CLOCK', 'SK': 'SCENARIO_LOCK',
                'running': True,
                'startedAt': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()),
            })
        else:
            table.delete_item(Key={'PK': 'DEMO_CLOCK', 'SK': 'SCENARIO_LOCK'})
    except Exception as e:
        logger.warning('Failed to set scenario lock: %s', e)


def _decimal_hook(obj):
    """Convert floats to Decimal for DynamoDB compatibility."""
    if isinstance(obj, float):
        return Decimal(str(round(obj, 6)))
    raise TypeError


def _fix_decimals(item: dict) -> dict:
    """Recursively convert floats to Decimals in a DDB item."""
    fixed = {}
    for k, v in item.items():
        if isinstance(v, float):
            fixed[k] = Decimal(str(round(v, 6)))
        elif isinstance(v, dict):
            fixed[k] = _fix_decimals(v)
        elif isinstance(v, list):
            fixed[k] = [Decimal(str(round(x, 6))) if isinstance(x, float) else x for x in v]
        else:
            fixed[k] = v
    return fixed


def load_scenario(filename: str) -> tuple[list[dict], list[dict]]:
    """Load JSONL and split into seed and live events."""
    filepath = os.path.join(SCENARIO_DIR, filename)
    if not os.path.exists(filepath):
        # Try absolute path
        filepath = filename
    if not os.path.exists(filepath):
        logger.error('Scenario file not found: %s', filename)
        return [], []

    seed_events = []
    live_events = []

    with open(filepath) as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                if event.get('phase') == 'seed':
                    seed_events.append(event)
                elif event.get('phase') == 'live':
                    live_events.append(event)
            except json.JSONDecodeError as e:
                logger.warning('JSON error on line %d: %s', i + 1, e)

    # Sort live events by t_sec
    live_events.sort(key=lambda e: e.get('t_sec', 0))

    logger.info('Loaded scenario: %d seed + %d live = %d total',
                len(seed_events), len(live_events), len(seed_events) + len(live_events))
    return seed_events, live_events


async def run_seed(dynamodb, seed_events: list[dict]) -> int:
    """Write seed events to DynamoDB with throttling for MSK connection safety."""
    if not seed_events:
        return 0

    # Group by table
    by_table: dict[str, list[dict]] = {}
    for event in seed_events:
        table_name = event.get('table', '')
        if not table_name:
            continue
        by_table.setdefault(table_name, []).append(event)

    total_target = len(seed_events)
    total = 0
    for table_name, events in by_table.items():
        table = dynamodb.Table(table_name)
        written = 0
        for event in events:
            item = _fix_decimals(event.get('item', {}))
            if not item.get('PK'):
                continue
            try:
                table.put_item(Item=item)
                written += 1
                total += 1
            except Exception as e:
                logger.warning('Seed put_item error: %s PK=%s — %s', table_name, item.get('PK', '?'), e)
            # Throttle: 5 items then pause — keeps MSK connections under control
            if written % 5 == 0:
                await asyncio.sleep(1.0)
                # Update progress every 10 items
                if written % 10 == 0:
                    _write_seed_status(dynamodb, 'IN_PROGRESS', total, total_target)
        logger.info('Seed: %s — %d items written (total: %d/%d)', table_name, written, total, total_target)
        _write_seed_status(dynamodb, 'IN_PROGRESS', total, total_target)
        # Pause between tables to let producer Lambda invocations complete
        logger.info('Waiting 10s for %s producers to drain...', table_name)
        await asyncio.sleep(10)

    return total


async def run_live(dynamodb, live_events: list[dict], state: dict) -> None:
    """Replay live events at timed intervals. Writes one event at a time to DDB."""
    if not live_events:
        logger.info('No live events to replay')
        return

    start_time = time.time()
    total = len(live_events)
    idx = 0

    logger.info('Live replay starting — %d events over %d seconds',
                total, live_events[-1].get('t_sec', 0))

    while idx < total:
        elapsed = time.time() - start_time
        event = live_events[idx]
        t_sec = event.get('t_sec', 0)

        # Wait until it's time for this event
        if elapsed < t_sec:
            await asyncio.sleep(min(t_sec - elapsed, 1.0))
            continue

        # Write the event
        table_name = event.get('table', '')
        item = _fix_decimals(event.get('item', {}))

        if table_name and item.get('PK'):
            try:
                table = dynamodb.Table(table_name)
                table.put_item(Item=item)
                domain = event.get('domain', '?')
                entity = item.get('PK', '?')
                logger.info('[T+%03d] %s → %s %s', t_sec, domain, table_name, entity[:40])
            except Exception as e:
                logger.error('[T+%03d] Write error: %s — %s', t_sec, table_name, e)

        idx += 1

    elapsed = time.time() - start_time
    logger.info('Live replay complete — %d events in %.0fs', total, elapsed)


def _write_seed_status(dynamodb, status: str, item_count: int = 0, total_target: int = 0):
    """Write seed status to demo-control for frontend polling."""
    try:
        table = dynamodb.Table(DEMO_CONTROL_TABLE)
        table.put_item(Item={
            'PK': 'DEMO_CLOCK', 'SK': 'SEED_STATUS',
            'status': status,
            'itemCount': item_count,
            'totalTarget': total_target,
            'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime()),
        })
    except Exception as e:
        logger.warning('Failed to write seed status: %s', e)


def _is_seed_completed(dynamodb) -> bool:
    """Check if seed already completed (don't re-run)."""
    try:
        table = dynamodb.Table(DEMO_CONTROL_TABLE)
        resp = table.get_item(Key={'PK': 'DEMO_CLOCK', 'SK': 'SEED_STATUS'})
        return resp.get('Item', {}).get('status') == 'COMPLETED'
    except Exception:
        return False


async def run_seed_only(dynamodb, state: dict) -> None:
    """Seed phase only — bulk load historical events, then idle."""
    if _is_seed_completed(dynamodb):
        return
    if _is_scenario_running(dynamodb):
        logger.debug('Scenario already running — skipping')
        return

    filename = state.get('scenarioFile', 'ares1-outline.jsonl')
    seed_events, _ = load_scenario(filename)

    if not seed_events:
        logger.error('No seed events loaded')
        return

    _set_scenario_lock(dynamodb, True)
    _write_seed_status(dynamodb, 'IN_PROGRESS')

    try:
        logger.info('=== SEED SCENARIO: %d events ===', len(seed_events))
        seed_count = await run_seed(dynamodb, seed_events)
        logger.info('Seed complete: %d items written', seed_count)
        _write_seed_status(dynamodb, 'COMPLETED', seed_count, len(seed_events))
    except Exception:
        _write_seed_status(dynamodb, 'FAILED')
        raise
    finally:
        _set_scenario_lock(dynamodb, False)


async def run_replay_only(dynamodb, state: dict) -> None:
    """Live replay only — assumes seed already done."""
    if _is_scenario_running(dynamodb):
        logger.debug('Scenario already running — skipping')
        return

    filename = state.get('scenarioFile', 'ares1-outline.jsonl')
    _, live_events = load_scenario(filename)

    if not live_events:
        logger.error('No live events loaded')
        return

    _set_scenario_lock(dynamodb, True)

    try:
        logger.info('=== PLAY SCENARIO: %d events over %ds ===',
                     len(live_events), live_events[-1].get('t_sec', 0))
        await run_live(dynamodb, live_events, state)
        logger.info('=== Replay complete ===')
    finally:
        _set_scenario_lock(dynamodb, False)


async def run_scenario(dynamodb, state: dict) -> None:
    """Legacy: run both seed + replay sequentially."""
    if _is_scenario_running(dynamodb):
        logger.debug('Scenario already running — skipping')
        return

    filename = state.get('scenarioFile', 'ares1-outline.jsonl')
    seed_events, live_events = load_scenario(filename)

    if not seed_events and not live_events:
        logger.error('No events loaded')
        return

    _set_scenario_lock(dynamodb, True)
    _write_seed_status(dynamodb, 'IN_PROGRESS')

    try:
        logger.info('=== Phase 1: Seeding %d events ===', len(seed_events))
        seed_count = await run_seed(dynamodb, seed_events)
        logger.info('Seed complete: %d items written', seed_count)
        _write_seed_status(dynamodb, 'COMPLETED', seed_count, len(seed_events))

        logger.info('Waiting 5s for stream propagation...')
        await asyncio.sleep(5)

        logger.info('=== Phase 2: Live replay %d events ===', len(live_events))
        await run_live(dynamodb, live_events, state)

        logger.info('=== Scenario complete ===')
    except Exception:
        _write_seed_status(dynamodb, 'FAILED')
        raise
    finally:
        _set_scenario_lock(dynamodb, False)
