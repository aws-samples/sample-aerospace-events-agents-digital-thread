import { useState, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

const API_GATEWAY_URL = import.meta.env.VITE_API_GATEWAY_URL || '';

export type DatalakeState = {
  rows: any[];
  loading: boolean;
  error: string | null;
  executionMs?: number;
  scannedRows?: number;
};

/**
 * Generic Athena-over-Iceberg query hook. Runs any of the 13 named queries (or a
 * freeform SELECT) through API Gateway → athena-query Lambda, and returns the raw rows
 * plus the live execution time so the UI can show "Athena over Iceberg · {ms}".
 *
 * This is the datalake counterpart to queryNeptune() on the Digital Thread page — the
 * frontend's window onto S3 + Iceberg history.
 */
export function useDatalake() {
  const [state, setState] = useState<DatalakeState>({ rows: [], loading: false, error: null });

  const run = useCallback(async (query: string, parameters: Record<string, any> = {}) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      if (!API_GATEWAY_URL) {
        setState({ rows: [], loading: false, error: 'API Gateway not configured', executionMs: 0 });
        return { rows: [], executionMs: 0 };
      }
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      const response = await fetch(`${API_GATEWAY_URL}query/athena`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, parameters }),
      });
      if (!response.ok) {
        // surface the Lambda's error body (e.g. "Only SELECT queries are allowed")
        let msg = `Query failed: ${response.status}`;
        try { const b = await response.json(); if (b.error) msg = b.error; } catch { /* ignore */ }
        throw new Error(msg);
      }
      const result = await response.json();
      const rows = result.data ?? result.rows ?? [];
      setState({ rows, loading: false, error: null, executionMs: result.executionMs, scannedRows: result.scannedRows });
      return { rows, executionMs: result.executionMs };
    } catch (err: any) {
      setState({ rows: [], loading: false, error: err.message ?? 'Query failed' });
      return { rows: [], executionMs: 0 };
    }
  }, []);

  return { ...state, run };
}
