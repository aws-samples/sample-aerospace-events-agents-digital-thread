"""AWS Agent Registry client — agent-side discovery + ARN resolution for A2A calls.

Replaces the self-managed s3://.../configs/agent-registry.json name->ARN map with the
managed AWS Bedrock AgentCore Agent Registry (preview). Each agent is an A2A registry
record whose agentCard.inlineContent carries the A2A agent card; card["url"] is the
runtime invocation endpoint we dispatch to.

- Discovery:  list_records()            -> control plane list_registry_records (APPROVED)
- Search:     search(query)             -> data plane search_registry_records (semantic)
- Resolve:    resolve_url(agent_id)      -> agent card url (runtime endpoint) for a name

Requires botocore >= 1.43.0 (registry ops). See spikes/agent-registry/FINDINGS.md.
Falls back gracefully (empty / None) when REGISTRY_ID is unset or the SDK is too old, so
call sites can dual-run against the JSON file behind a feature flag during migration.
"""

import json
import logging
import os

import boto3

logger = logging.getLogger('registry_client')

REGION = os.environ.get('AWS_REGION', 'eu-west-1')
REGISTRY_ID = os.environ.get('REGISTRY_ID', '')

# Module-level caches — one container processes one session, so cache for its lifetime.
_records_cache: list | None = None
_url_cache: dict[str, str] = {}


def _control():
    return boto3.client('agent-registry-control', region_name=REGION)


def _data():
    return boto3.client('agent-registry', region_name=REGION)


def enabled() -> bool:
    """True when a registry is configured. Lets callers fall back to the JSON map."""
    return bool(REGISTRY_ID)


def list_records(force: bool = False) -> list[dict]:
    """All APPROVED A2A records in the registry (cached). Empty list on any failure."""
    global _records_cache
    if _records_cache is not None and not force:
        return _records_cache
    if not REGISTRY_ID:
        return []
    try:
        resp = _control().list_registry_records(registryId=REGISTRY_ID)
        recs = resp.get('registryRecords', resp.get('records', []))
        approved = [r for r in recs
                    if r.get('status') == 'APPROVED' and r.get('recordType') == 'AGENT']
        _records_cache = approved
        logger.info('Registry: %d approved A2A records', len(approved))
        return approved
    except Exception as e:
        logger.warning('Registry list_records failed: %s', e)
        return []


def list_agent_ids(exclude: str = '') -> list[str]:
    """Agent names (record names) available for A2A, optionally excluding the caller."""
    return sorted(r['name'] for r in list_records() if r.get('name') and r['name'] != exclude)


def search(query: str, max_results: int = 5, exclude: str = '') -> list[str]:
    """Semantic search for agents by capability. Returns matching agent names.

    This is the headline upgrade over the old substring match: search by meaning
    (e.g. "supplier quality problems" -> agent4-supplier-risk).
    """
    if not REGISTRY_ID:
        return []
    try:
        resp = _data().search_discoverable_registry_records(
            registryIds=[REGISTRY_ID], searchQuery=query, maxResults=max_results)
        recs = resp.get('registryRecords', resp.get('records', []))
        names = [r.get('name') for r in recs if r.get('name') and r.get('name') != exclude]
        logger.info('Registry search %r -> %s', query[:60], names)
        return [n for n in names if n]
    except Exception as e:
        logger.warning('Registry search failed: %s', e)
        return []


def resolve_url(agent_id: str) -> str | None:
    """Resolve an agent name to its A2A invocation endpoint (agent card url).

    Reads the card from the matching list_records() entry; if the list summary omits
    descriptors, fetches the full record. Returns None if unknown.
    """
    if agent_id in _url_cache:
        return _url_cache[agent_id]
    if not REGISTRY_ID:
        return None
    rec = next((r for r in list_records() if r.get('name') == agent_id), None)
    if not rec:
        return None
    url = _card_url(rec.get('descriptors'))
    if not url:
        # List summary may not include descriptors — fetch the full record.
        rec_id = rec.get('recordId') or rec.get('recordArn', '').split('/')[-1]
        try:
            full = _control().get_registry_record(registryId=REGISTRY_ID, recordId=rec_id)
            url = _card_url(full.get('descriptors'))
        except Exception as e:
            logger.warning('Registry get_registry_record(%s) failed: %s', agent_id, e)
            return None
    if url:
        _url_cache[agent_id] = url
    return url


def _card_url(descriptors: dict | None) -> str | None:
    """Pull agentCard.url out of an A2A descriptor's inlineContent."""
    if not descriptors:
        return None
    inline = descriptors.get('a2aAgentCard', {}).get('data')
    if not inline:
        return None
    try:
        return json.loads(inline).get('url')
    except (ValueError, TypeError):
        return None


def runtime_arn(agent_id: str) -> str | None:
    """Resolve an agent name to its runtime ARN (decoded from the card url).

    The card url is .../runtimes/<url-escaped-arn>/invocations/ — recover the ARN
    by un-escaping that path segment. Lets ARN-based callers (session stop, scripts)
    use the registry instead of the JSON map.
    """
    url = resolve_url(agent_id)
    if not url:
        return None
    import urllib.parse
    marker = '/runtimes/'
    if marker not in url:
        return None
    seg = url.split(marker, 1)[1].split('/invocations', 1)[0]
    arn = urllib.parse.unquote(seg)
    return arn if arn.startswith('arn:') else None


def runtime_arn_map() -> dict[str, str]:
    """{agent_id: runtime_arn} for all approved records — registry-backed replacement
    for the agent-registry.json map. Empty dict if the registry is unavailable."""
    out: dict[str, str] = {}
    for r in list_records():
        name = r.get('name')
        if not name:
            continue
        arn = runtime_arn(name)
        if arn:
            out[name] = arn
    return out
