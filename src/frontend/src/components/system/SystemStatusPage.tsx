/**
 * System status page — uses AppSync onDashboardEvent subscription for real-time updates
 * and API Gateway scan for initial record loading.
 */

import { useState, useEffect, useRef } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { generateClient } from 'aws-amplify/api';
import { Radio, Database } from 'lucide-react';
import { onDashboardEvent } from '../../lib/graphql/operations';

const API_URL = import.meta.env.VITE_API_GATEWAY_URL || '';

let _client: ReturnType<typeof generateClient> | null = null;
function getClient() {
  if (!_client) _client = generateClient();
  return _client;
}

type Props = {
  title: string;
  description: string;
  tableName: string;
  domain: string;
  channel: string;
  fields: string[];
};

type LiveEvent = {
  eventId: string;
  eventType: string;
  entityId: string;
  occurredAt: string;
  payload: Record<string, any>;
};

export function SystemStatusPage({ title, description, tableName, domain, channel, fields }: Props) {
  const [items, setItems] = useState<Record<string, any>[]>([]);
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const subRef = useRef<any>(null);

  // Initial load via API Gateway scan
  useEffect(() => {
    let mounted = true;

    async function fetchData() {
      if (!API_URL) { setLoading(false); return; }
      try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();
        const response = await fetch(`${API_URL}query/scan`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ tableName, limit: 50 }),
        });

        if (response.ok) {
          const data = await response.json();
          const body = typeof data.body === 'string' ? JSON.parse(data.body) : data;
          if (mounted) setItems(body.items ?? []);
        } else {
          console.warn(`[${domain}] Scan not available (${response.status}) — showing live events only`);
        }
      } catch (err) {
        console.error(`[${domain}] Fetch error:`, err);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    fetchData();
    return () => { mounted = false; };
  }, [tableName, domain]);

  // Real-time subscription for new events via AppSync
  useEffect(() => {
    const sub = (getClient().graphql({
      query: onDashboardEvent,
      variables: { channel },
    }) as any).subscribe({
      next: ({ data }: any) => {
        const event = data?.onDashboardEvent;
        if (!event || event.domain !== domain) return;
        const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
        setLiveEvents((prev) => [{
          eventId: event.eventId,
          eventType: event.eventType,
          entityId: event.entityId,
          occurredAt: event.occurredAt,
          payload,
        }, ...prev].slice(0, 50));
      },
      error: (err: any) => console.error(`[${domain}] Subscription error:`, err),
    });
    subRef.current = sub;
    return () => sub.unsubscribe();
  }, [channel, domain]);

  const totalCount = items.length + liveEvents.length;

  return (
    <div className="max-w-[1400px] mx-auto">
      <div className="flex items-start justify-between mb-5">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h2 className="text-xl font-bold text-text-primary tracking-tight">{title}</h2>
            <div className="flex items-center gap-1.5 opacity-60">
              <Database size={12} className="text-text-muted" />
              <span className="text-[10px] font-mono text-text-muted">{tableName}</span>
            </div>
          </div>
          <p className="text-[13px] text-text-tertiary">{description}</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-secondary rounded-lg border border-border">
          <Radio size={10} className={totalCount > 0 ? 'text-status-success' : 'text-text-muted'} />
          <span className="text-[11px] font-mono text-text-muted">{totalCount} records</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Live Event Stream */}
        <div className="bg-surface-primary border border-border rounded-xl overflow-hidden shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Radio size={12} className={liveEvents.length > 0 ? 'text-status-success animate-[pulse-glow_2s_ease-in-out_infinite]' : 'text-text-muted'} />
            <h3 className="text-[13px] font-bold text-text-primary uppercase tracking-wide">Live Events</h3>
            <span className="text-[10px] font-mono text-text-muted ml-auto">{liveEvents.length} events</span>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {liveEvents.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-[12px] text-text-muted font-mono">Awaiting events...</p>
              </div>
            ) : (
              liveEvents.map((e) => (
                <div key={e.eventId} className="px-4 py-2 border-b border-border/40">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[11px] font-mono font-semibold text-accent">{e.eventType}</span>
                    <span className="text-[10px] font-mono text-text-muted">
                      {new Date(e.occurredAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-text-secondary">{e.entityId}</span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* DDB Records Table */}
        <div className="bg-surface-primary border border-border rounded-xl overflow-hidden shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]">
          <div className="px-4 py-3 border-b border-border flex items-center gap-2">
            <Database size={12} className="text-text-muted" />
            <h3 className="text-[13px] font-bold text-text-primary uppercase tracking-wide">Records</h3>
            <span className="text-[10px] font-mono text-text-muted ml-auto">{items.length} loaded</span>
          </div>
          <div className="max-h-[400px] overflow-x-auto overflow-y-auto">
            {loading ? (
              <div className="py-8 text-center">
                <div className="inline-block w-5 h-5 border-2 border-border-strong border-t-accent rounded-full animate-spin" />
              </div>
            ) : items.length === 0 ? (
              <div className="px-4 py-8 text-center">
                <p className="text-[12px] text-text-muted font-mono">Generator will populate data</p>
              </div>
            ) : (
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border bg-surface-secondary">
                    {fields.map((f) => (
                      <th key={f} className="px-3 py-2 text-[10px] font-bold text-text-muted uppercase tracking-wider font-mono whitespace-nowrap">
                        {f.replace(/([A-Z])/g, ' $1').trim()}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <tr key={item.PK || i} className="border-b border-border/40 hover:bg-surface-secondary transition-colors">
                      {fields.map((f) => (
                        <td key={f} className="px-3 py-2 text-[12px] font-mono text-text-secondary truncate max-w-[180px]">
                          {item[f] != null ? String(item[f]) : '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
