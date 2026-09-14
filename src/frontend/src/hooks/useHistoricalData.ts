import { useState, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

const API_GATEWAY_URL = import.meta.env.VITE_API_GATEWAY_URL || '';
const REGION = import.meta.env.VITE_AWS_REGION || 'eu-west-1';

export type NcrTrendPoint = {
  date: string;
  MINOR: number;
  MAJOR: number;
  CRITICAL: number;
  total: number;
};

export type HistoricalDataState = {
  data: NcrTrendPoint[];
  loading: boolean;
  error: string | null;
  executionMs?: number;
};

/**
 * Query Athena for historical NCR trend data via API Gateway.
 * Falls back to direct Athena SDK call if API Gateway not configured.
 */
export function useHistoricalData() {
  const [state, setState] = useState<HistoricalDataState>({
    data: [],
    loading: false,
    error: null,
  });

  const fetchNcrTrend = useCallback(async (days: number = 7) => {
    setState((s) => ({ ...s, loading: true, error: null }));

    try {
      if (!API_GATEWAY_URL) {
        // Mock data for development until API Gateway is deployed
        const mockData = generateMockData(days);
        setState({ data: mockData, loading: false, error: null, executionMs: 50 });
        return;
      }

      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();

      const response = await fetch(`${API_GATEWAY_URL}/query/athena`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          query: 'ncrTrend',
          parameters: { days, groupBy: 'severity' },
        }),
      });

      if (!response.ok) {
        throw new Error(`Query failed: ${response.status}`);
      }

      const result = await response.json();
      setState({
        data: pivotBySeverity(result.data ?? []),
        loading: false,
        error: null,
        executionMs: result.executionMs,
      });
    } catch (err: any) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err.message ?? 'Query failed',
      }));
    }
  }, []);

  return { ...state, fetchNcrTrend };
}

/**
 * Athena returns one row per (date, severity): {date, severity, cnt}. Recharts'
 * stacked bars need one row per date with MINOR/MAJOR/CRITICAL columns — pivot here.
 * Pass-through if the data already arrives pivoted.
 */
function pivotBySeverity(rows: any[]): NcrTrendPoint[] {
  if (rows.length === 0 || rows[0].severity === undefined) return rows as NcrTrendPoint[];
  const byDate = new Map<string, NcrTrendPoint>();
  for (const r of rows) {
    const date = r.date;
    const point = byDate.get(date) ?? { date, MINOR: 0, MAJOR: 0, CRITICAL: 0, total: 0 };
    const sev = String(r.severity || '').toUpperCase();
    const n = Number(r.cnt) || 0;
    if (sev === 'MINOR' || sev === 'MAJOR' || sev === 'CRITICAL') point[sev] += n;
    point.total += n;
    byDate.set(date, point);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function generateMockData(days: number): NcrTrendPoint[] {
  const data: NcrTrendPoint[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const minor = Math.floor(Math.random() * 5) + 1;
    const major = Math.floor(Math.random() * 3);
    const critical = Math.random() > 0.7 ? 1 : 0;
    data.push({
      date: d.toISOString().slice(0, 10),
      MINOR: minor,
      MAJOR: major,
      CRITICAL: critical,
      total: minor + major + critical,
    });
  }
  return data;
}
