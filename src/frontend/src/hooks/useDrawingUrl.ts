import { useState, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';

const API_GATEWAY_URL = import.meta.env.VITE_API_GATEWAY_URL || '';

export type DrawingUrlState = {
  url: string | null;
  loading: boolean;
  error: string | null;
};

/**
 * Resolve a private PLM drawing PNG (S3 key under `drawings/`) to a short-TTL
 * presigned GET URL via API Gateway. Mirrors useHistoricalData's auth pattern.
 */
export function useDrawingUrl() {
  const [state, setState] = useState<DrawingUrlState>({
    url: null,
    loading: false,
    error: null,
  });

  const fetchDrawingUrl = useCallback(async (key: string) => {
    setState((s) => ({ ...s, loading: true, error: null }));

    try {
      if (!API_GATEWAY_URL) {
        throw new Error('API Gateway not configured');
      }

      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();

      const response = await fetch(
        `${API_GATEWAY_URL}/drawings/presign?key=${encodeURIComponent(key)}`,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
          },
        },
      );

      if (!response.ok) {
        throw new Error(`Presign failed: ${response.status}`);
      }

      const result = await response.json();
      setState({ url: result.url ?? null, loading: false, error: null });
    } catch (err: any) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err.message ?? 'Presign failed',
      }));
    }
  }, []);

  return { ...state, fetchDrawingUrl };
}
