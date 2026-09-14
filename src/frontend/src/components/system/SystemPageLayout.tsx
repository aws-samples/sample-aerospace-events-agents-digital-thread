import { useState, useEffect, useRef, useMemo } from 'react';
import { generateClient } from 'aws-amplify/api';
import { Plus, Radio, Search, X } from 'lucide-react';
import { EntityTable, type FieldConfig } from './EntityTable';
import { EntityForm } from './EntityForm';

let _client: ReturnType<typeof generateClient> | null = null;
function getClient() {
  if (!_client) _client = generateClient();
  return _client;
}

type SystemPageLayoutProps = {
  title: string;
  description: string;
  primaryKey: string;
  fields: FieldConfig[];
  createDefaults: Record<string, any>;
  listQuery: string;
  listQueryName: string;
  createMutation: string;
  subscriptionQuery: string;
  subscriptionName: string;
  entityLabel?: string;
  /** Optional render slot below the table, given the current items (e.g. drawing gallery). */
  renderExtra?: (items: Record<string, any>[]) => React.ReactNode;
};

export function SystemPageLayout({
  title, description, primaryKey, fields, createDefaults,
  listQuery, listQueryName, createMutation,
  subscriptionQuery, subscriptionName, entityLabel = 'Record', renderExtra,
}: SystemPageLayoutProps) {
  const [items, setItems] = useState<Record<string, any>[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [live, setLive] = useState(false);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const subRef = useRef<any>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Filter items by search query across all visible fields
  const filteredItems = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter((item) =>
      fields.some((f) => {
        const val = item[f.key];
        return val != null && String(val).toLowerCase().includes(q);
      })
    );
  }, [items, search, fields]);

  // Load existing records
  useEffect(() => {
    (async () => {
      try {
        // 200 so all of a system's records (incl. every drawing the gallery renders)
        // arrive in the first page — the gallery must not depend on table pagination.
        const result: any = await getClient().graphql({ query: listQuery, variables: { limit: 200 } });
        setItems(result.data[listQueryName].items);
        setNextToken(result.data[listQueryName].nextToken ?? null);
      } catch (err) {
        console.error('Failed to load records:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [listQuery, listQueryName]);

  const loadMore = async () => {
    if (!nextToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const result: any = await getClient().graphql({
        query: listQuery,
        variables: { limit: 50, nextToken },
      });
      setItems((prev) => [...prev, ...result.data[listQueryName].items]);
      setNextToken(result.data[listQueryName].nextToken ?? null);
    } catch (err) {
      console.error('Failed to load more:', err);
    } finally {
      setLoadingMore(false);
    }
  };

  // Subscribe to new records
  useEffect(() => {
    const sub = (getClient().graphql({ query: subscriptionQuery }) as any).subscribe({
      next: ({ data }: any) => {
        const item = data?.[subscriptionName];
        if (item) {
          setItems((prev) => [item, ...prev]);
          setLive(true);
          setTimeout(() => setLive(false), 2000);
        }
      },
      error: (err: any) => console.error('Subscription error:', err),
    });
    subRef.current = sub;
    return () => sub.unsubscribe();
  }, [subscriptionQuery, subscriptionName]);

  const handleCreate = async (data: Record<string, any>) => {
    try {
      await getClient().graphql({
        query: createMutation,
        variables: { input: data },
      });
      setShowForm(false);
    } catch (err) {
      console.error('Failed to create record:', err);
    }
  };

  return (
    <div className="max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h2 className="text-xl font-bold text-text-primary tracking-tight">
              {title}
            </h2>
            {/* Live indicator */}
            <div className={`flex items-center gap-1.5 transition-opacity duration-300 ${
              live ? 'opacity-100' : 'opacity-0'
            }`}>
              <Radio size={12} className="text-status-success animate-[pulse-glow_1s_ease-in-out_infinite]" />
              <span className="text-[10px] font-mono font-semibold text-status-success uppercase">
                Live
              </span>
            </div>
          </div>
          <p className="text-[13px] text-text-tertiary">{description}</p>
        </div>

        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-4 py-2 text-[12px] font-bold
            text-white bg-accent rounded-lg
            hover:bg-accent-hover transition-colors uppercase tracking-wide"
        >
          <Plus size={14} strokeWidth={2.5} />
          New {entityLabel}
        </button>
      </div>

      {/* Search + record count */}
      <div className="flex items-center gap-3 mb-3">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search records..."
            className="w-[220px] pl-7 pr-7 py-1.5 text-[11px] font-mono bg-surface-primary border border-border rounded-lg
              text-text-primary placeholder-text-muted
              focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
          />
          {search && (
            <button onClick={() => { setSearch(''); searchRef.current?.focus(); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary">
              <X size={12} />
            </button>
          )}
        </div>
        <span className="text-[11px] font-mono text-text-muted">
          {search ? `${filteredItems.length} / ${items.length}` : items.length} record{(search ? filteredItems.length : items.length) !== 1 ? 's' : ''}
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Table */}
      <div className="bg-surface-primary border border-border rounded-xl overflow-hidden
        shadow-[0_1px_3px_0_rgb(0_0_0/0.08),0_1px_2px_-1px_rgb(0_0_0/0.08)]">
        {loading ? (
          <div className="py-16 text-center">
            <div className="inline-block w-5 h-5 border-2 border-border-strong border-t-accent rounded-full animate-spin" />
            <p className="text-text-muted text-xs mt-3 font-mono">Loading records...</p>
          </div>
        ) : (
          <>
            <EntityTable fields={fields} items={filteredItems} primaryKey={primaryKey} />
            {nextToken && (
              <div className="px-4 py-3 border-t border-border text-center">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="px-4 py-1.5 text-[12px] font-medium text-accent bg-accent-subtle
                    border border-accent/15 rounded-lg hover:bg-accent/10 transition-colors
                    disabled:opacity-50"
                >
                  {loadingMore ? 'Loading...' : 'Load More'}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Optional extra content (e.g. PLM released-drawings gallery) */}
      {!loading && renderExtra && renderExtra(items)}

      {/* Create modal */}
      {showForm && (
        <EntityForm
          fields={fields}
          defaults={createDefaults}
          onSubmit={handleCreate}
          onCancel={() => setShowForm(false)}
        />
      )}
    </div>
  );
}
