import { useEffect } from 'react';
import { useDrawingUrl } from '../../hooks/useDrawingUrl';

/**
 * Renders a private PLM drawing (S3 key under `drawings/`) inline by resolving it
 * to a short-TTL presigned URL. Used in the PLM page and the digital-thread node
 * detail panel — the unstructured artifact shown in-app.
 */
export function DrawingViewer({ s3Key, height = 320 }: { s3Key: string; height?: number }) {
  const { url, loading, error, fetchDrawingUrl } = useDrawingUrl();

  useEffect(() => {
    if (s3Key) fetchDrawingUrl(s3Key);
  }, [s3Key, fetchDrawingUrl]);

  if (loading) {
    return <div className="text-[11px] font-mono text-text-muted py-4 text-center">Loading drawing…</div>;
  }
  if (error) {
    return <div className="text-[11px] font-mono text-status-warning-text py-4 text-center">Drawing unavailable: {error}</div>;
  }
  if (!url) return null;

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-white">
      <a href={url} target="_blank" rel="noreferrer" title="Open full drawing">
        <img src={url} alt="Engineering drawing" style={{ width: '100%', height, objectFit: 'contain' }} />
      </a>
    </div>
  );
}
