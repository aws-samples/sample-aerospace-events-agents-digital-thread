"""Demo generator — scheduler loop that fires domain generators per tick."""

import asyncio
import logging
import os
import time

import boto3

from generators.gen_qms import run as gen_qms_run
from generators.gen_mes import run as gen_mes_run
from generators.gen_plm import run as gen_plm_run
from generators.gen_erp import run as gen_erp_run
from generators.gen_srm import run as gen_srm_run
from generators.gen_wms import run as gen_wms_run
from generators.gen_dhr import run as gen_dhr_run
from generators.gen_program import run as gen_program_run
from generators.gen_inservice import run as gen_inservice_run
from generators.gen_scada import scada_loop
from generators.scenario_runner import run_scenario, run_seed_only, run_replay_only

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s %(name)s %(levelname)s %(message)s',
)
logger = logging.getLogger('demo-generator')

TICK_INTERVAL_DEFAULT = 10  # seconds
DEMO_CONTROL_TABLE = os.environ.get('DEMO_CONTROL_TABLE', 'demo-control')
AWS_REGION = os.environ.get('AWS_REGION', 'eu-west-1')

# Auto-stop: the generator scales its own ECS service to 0 after this many hours,
# so a demo left running doesn't bloat the graph indefinitely. Configurable live from
# the frontend Demo Control (writes autoStopHours into demo-control); 0 = never stop.
AUTO_STOP_HOURS_DEFAULT = 8.0
GENERATOR_CLUSTER = os.environ.get('GENERATOR_CLUSTER', 'aerospace-demo-generator')
_START_MONOTONIC = time.monotonic()

# Generator schedule: (name, function, every_n_ticks, offset)
# At 10s tick: staggered so not all fire on the same tick
GENERATORS = [
    ('gen_qms', gen_qms_run, 6, 0),       # every 60s, offset 0
    ('gen_mes', gen_mes_run, 6, 1),        # every 60s, offset 10s
    ('gen_plm', gen_plm_run, 6, 2),        # every 60s, offset 20s
    ('gen_erp', gen_erp_run, 6, 3),        # every 60s, offset 30s
    ('gen_wms', gen_wms_run, 6, 4),        # every 60s, offset 40s
    ('gen_dhr', gen_dhr_run, 6, 5),        # every 60s, offset 50s
    ('gen_srm', gen_srm_run, 12, 5),       # every 2 min
    ('gen_program', gen_program_run, 12, 0),  # every 2 min
    ('gen_inservice', gen_inservice_run, 6, 3),  # every 60s, offset 30s
]


def get_dynamodb():
    return boto3.resource('dynamodb', region_name=AWS_REGION)


def read_demo_state(dynamodb) -> dict:
    """Read current demo state from demo-control table."""
    try:
        table = dynamodb.Table(DEMO_CONTROL_TABLE)
        resp = table.get_item(Key={'PK': 'DEMO_CLOCK', 'SK': 'STATE'})
        item = resp.get('Item', {})
        return {
            'phase': item.get('phase', 'PRODUCTION'),
            'tickIntervalS': int(item.get('tickIntervalS', TICK_INTERVAL_DEFAULT)),
            'eventDensity': float(item.get('eventDensity', 1.0)),
            'mode': item.get('mode', 'DRAMA'),
            'scenarioFile': item.get('scenarioFile', 'ares1-outline.jsonl'),
            'autoStopHours': float(item.get('autoStopHours', AUTO_STOP_HOURS_DEFAULT)),
        }
    except Exception as e:
        logger.warning('Failed to read demo-control: %s — using defaults', e)
        return {
            'phase': 'PRODUCTION',
            'tickIntervalS': TICK_INTERVAL_DEFAULT,
            'eventDensity': 1.0,
            'mode': 'DRAMA',
            'scenarioFile': 'ares1-outline.jsonl',
            'autoStopHours': AUTO_STOP_HOURS_DEFAULT,
        }


async def scheduler():
    """Main scheduler loop — fires generators on their cadence, or runs scenario."""
    dynamodb = get_dynamodb()
    tick = 0
    logger.info('Scheduler started — %d generators registered', len(GENERATORS))

    while True:
        state = read_demo_state(dynamodb)
        mode = state['mode']
        interval = state['tickIntervalS']
        density = state['eventDensity']

        if mode == 'SEED SCENARIO':
            try:
                await run_seed_only(dynamodb, state)
            except Exception:
                logger.exception('Seed scenario error')
        elif mode == 'PLAY SCENARIO':
            try:
                await run_replay_only(dynamodb, state)
            except Exception:
                logger.exception('Play scenario error')
        elif mode == 'SCENARIO':
            try:
                await run_scenario(dynamodb, state)
            except Exception:
                logger.exception('Scenario error')
        else:
            # Normal SMOOTH/DRAMA mode — tick-based generators
            for name, fn, every_n, offset in GENERATORS:
                if (tick - offset) % every_n == 0:
                    try:
                        logger.info('tick=%d firing %s (phase=%s, density=%.1f, mode=%s)',
                                    tick, name, state['phase'], density, mode)
                        await fn(dynamodb, state, density)
                    except Exception:
                        logger.exception('Error in %s at tick %d', name, tick)

        tick += 1
        await asyncio.sleep(interval)


def _scale_service_to_zero():
    """Scale this generator's own ECS service to desiredCount=0 so it doesn't relaunch."""
    ecs = boto3.client('ecs', region_name=AWS_REGION)
    services = ecs.list_services(cluster=GENERATOR_CLUSTER).get('serviceArns', [])
    if not services:
        logger.warning('Auto-stop: no service found in cluster %s', GENERATOR_CLUSTER)
        return
    ecs.update_service(cluster=GENERATOR_CLUSTER, service=services[0], desiredCount=0)
    logger.info('Auto-stop: scaled %s to desiredCount=0', services[0])


async def auto_stop_watchdog(dynamodb):
    """Scale the generator to 0 after autoStopHours of runtime (0 = never).

    Re-reads the threshold from demo-control each cycle so the frontend can change it
    live. On trigger, scales the ECS service to 0 and stops the process so ECS won't
    relaunch the task. This is the guard against a left-running demo bloating the graph.
    """
    while True:
        await asyncio.sleep(60)
        try:
            hours = read_demo_state(dynamodb).get('autoStopHours', AUTO_STOP_HOURS_DEFAULT)
        except Exception:
            hours = AUTO_STOP_HOURS_DEFAULT
        if hours and hours > 0:
            elapsed_h = (time.monotonic() - _START_MONOTONIC) / 3600.0
            if elapsed_h >= hours:
                logger.info('Auto-stop: %.2fh elapsed >= %.2fh threshold — stopping generators',
                            elapsed_h, hours)
                try:
                    _scale_service_to_zero()
                except Exception:
                    logger.exception('Auto-stop: failed to scale service to 0')
                # Exit hard so the container terminates immediately (service is now at 0).
                os._exit(0)


async def main():
    """Entry point — runs scheduler + SCADA loop + auto-stop watchdog concurrently."""
    dynamodb = get_dynamodb()
    logger.info('Demo generator starting — region=%s, %d generators, auto-stop default %.1fh',
                AWS_REGION, len(GENERATORS), AUTO_STOP_HOURS_DEFAULT)
    await asyncio.gather(
        scheduler(),
        scada_loop(dynamodb),
        auto_stop_watchdog(dynamodb),
    )


if __name__ == '__main__':
    asyncio.run(main())
