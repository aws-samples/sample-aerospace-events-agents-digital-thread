/**
 * Demo Control Panel — generator start/stop, speed/density/phase tuning, drama injections.
 */

import { useState, useEffect, useCallback } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { Sliders, Zap, Play, Square, RotateCcw, AlertTriangle, Gauge, Plane, TrendingDown, Package, ShieldAlert, Target, Database, RefreshCw, Inbox, FileWarning } from 'lucide-react';
import { useEventContext } from '../context/EventProvider';

const API_URL = import.meta.env.VITE_API_GATEWAY_URL || '';

async function callHitl(operation: string, parameters: Record<string, any> = {}) {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  const resp = await fetch(`${API_URL}hitl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ operation, parameters }),
  });
  const data = await resp.json();
  return typeof data.body === 'string' ? JSON.parse(data.body) : data;
}

function ControlCard({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-surface-primary border border-border rounded-xl p-5 shadow-[0_1px_3px_0_rgb(0_0_0/0.08)]">
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <h3 className="text-[13px] font-bold text-text-primary uppercase tracking-wide">{title}</h3>
      </div>
      {children}
    </div>
  );
}

type GenStatus = 'RUNNING' | 'STOPPED' | 'LOADING';

export function DemoControlPage() {
  const { clearAll } = useEventContext();
  const [tickInterval, setTickInterval] = useState(10);
  const [density, setDensity] = useState(1.0);
  const [phase, setPhase] = useState('PRODUCTION');
  const [mode, setMode] = useState<'SMOOTH' | 'DRAMA' | 'SEED SCENARIO' | 'PLAY SCENARIO'>('DRAMA');
  const [autoStopHours, setAutoStopHours] = useState(8);  // generators self-stop after N hours (0 = never)
  const [seedStatus, setSeedStatus] = useState<{ status: string; itemCount: number; totalTarget: number; updatedAt?: string } | null>(null);
  const [injecting, setInjecting] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetResults, setResetResults] = useState<string[] | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedResult, setSeedResult] = useState<string | null>(null);
  const [genStatus, setGenStatus] = useState<GenStatus>('LOADING');
  const [genAction, setGenAction] = useState(false);
  const [dlqItems, setDlqItems] = useState<any[]>([]);
  const [dlqCount, setDlqCount] = useState(0);
  const [dlqLoading, setDlqLoading] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [replayResults, setReplayResults] = useState<string[] | null>(null);

  const refreshGenStatus = useCallback(async () => {
    try {
      const body = await callHitl('generator-status');
      setGenStatus(body.status === 'RUNNING' ? 'RUNNING' : 'STOPPED');
    } catch {
      setGenStatus('STOPPED');
    }
  }, []);

  const refreshDlq = useCallback(async () => {
    setDlqLoading(true);
    try {
      const body = await callHitl('dlq-status');
      setDlqCount(body.count ?? 0);
      setDlqItems(body.items ?? []);
    } catch {
      setDlqCount(0);
      setDlqItems([]);
    } finally {
      setDlqLoading(false);
    }
  }, []);

  // Load state + poll generator status
  useEffect(() => {
    callHitl('read-control').then((body) => {
      const state = body.item ?? {};
      if (state.tickIntervalS) setTickInterval(Number(state.tickIntervalS));
      if (state.eventDensity) setDensity(Number(state.eventDensity));
      if (state.phase) setPhase(state.phase);
      if (state.mode) setMode(state.mode);
      if (state.autoStopHours !== undefined) setAutoStopHours(Number(state.autoStopHours));
    });
    // Poll seed status
    callHitl('read-seed-status').then((body) => {
      if (body.item) setSeedStatus({ status: body.item.status, itemCount: body.item.itemCount ?? 0, totalTarget: body.item.totalTarget ?? 0, updatedAt: body.item.updatedAt });
    }).catch(() => {});
    refreshGenStatus();
    refreshDlq();
    const interval = setInterval(() => {
      refreshGenStatus();
      // Poll seed status (5s during seeding for progress bar, 15s otherwise)
      callHitl('read-seed-status').then((body) => {
        if (body.item) setSeedStatus({ status: body.item.status, itemCount: body.item.itemCount ?? 0, totalTarget: body.item.totalTarget ?? 0, updatedAt: body.item.updatedAt });
      }).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [refreshGenStatus, refreshDlq]);

  const updateClock = useCallback(async (updates: Record<string, any>) => {
    // Always carry autoStopHours through — write-control replaces the whole item, so
    // omitting a field would silently drop it.
    const newState = { tickIntervalS: tickInterval, eventDensity: density, phase, mode, autoStopHours, ...updates };
    setTickInterval(Number(newState.tickIntervalS));
    setDensity(Number(newState.eventDensity));
    setPhase(newState.phase);
    if (newState.mode) setMode(newState.mode);
    setAutoStopHours(Number(newState.autoStopHours));
    await callHitl('write-control', { key: 'DEMO_CLOCK', value: newState });
  }, [tickInterval, density, phase, mode, autoStopHours]);

  const handleInject = useCallback(async (scenario: string) => {
    setInjecting(scenario);
    try {
      await callHitl('inject-drama', { scenario });
    } finally {
      setTimeout(() => setInjecting(null), 2000);
    }
  }, []);

  const handleStartGen = useCallback(async () => {
    setGenAction(true);
    try {
      await callHitl('start-generators');
      setTimeout(refreshGenStatus, 3000);
    } finally {
      setGenAction(false);
    }
  }, [refreshGenStatus]);

  const handleStopGen = useCallback(async () => {
    setGenAction(true);
    try {
      await callHitl('stop-generators');
      setTimeout(refreshGenStatus, 3000);
    } finally {
      setGenAction(false);
    }
  }, [refreshGenStatus]);

  return (
    <div className="max-w-[900px] mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-text-primary tracking-tight">Demo Control Panel</h2>
          <p className="text-[13px] text-text-tertiary">Tune generators, inject drama scenarios, reset demo state</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-secondary rounded-lg border border-border">
          <span className={`w-2 h-2 rounded-full ${genStatus === 'RUNNING' ? 'bg-status-success animate-pulse' : genStatus === 'STOPPED' ? 'bg-status-error' : 'bg-text-muted'}`} />
          <span className="text-[11px] font-mono text-text-muted">
            Generators: <strong className={genStatus === 'RUNNING' ? 'text-status-success' : genStatus === 'STOPPED' ? 'text-status-error' : 'text-text-muted'}>
              {genStatus === 'LOADING' ? '...' : genStatus}
            </strong>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Generator Controls */}
        <ControlCard title="Generator Controls" icon={<Play size={14} className="text-status-success" />}>
          <div className="mb-4">
            <label className="text-[11px] font-mono text-text-muted block mb-2">
              Event Mode: <strong className={mode === 'SMOOTH' ? 'text-status-success' : mode.includes('SCENARIO') ? 'text-accent' : 'text-status-warning'}>{mode}</strong>
            </label>
            <div className="flex gap-2 flex-wrap">
              {(['SMOOTH', 'DRAMA', 'SEED SCENARIO', 'PLAY SCENARIO'] as const).map((m) => (
                <button key={m} onClick={() => updateClock({ mode: m })}
                  disabled={m === 'PLAY SCENARIO' && seedStatus?.status === 'IN_PROGRESS'}
                  className={`px-3 py-1.5 text-[11px] font-mono font-bold uppercase rounded-lg border transition-colors ${
                    mode === m
                      ? m === 'SMOOTH'
                        ? 'bg-status-success text-white border-status-success'
                        : m.includes('SCENARIO')
                          ? 'bg-accent text-white border-accent'
                          : 'bg-status-warning text-white border-status-warning'
                      : 'bg-surface-secondary text-text-secondary border-border hover:bg-surface-tertiary disabled:opacity-40'
                  }`}>{m}</button>
              ))}
            </div>
            <p className="text-[9px] text-text-muted mt-1">
              {mode === 'SMOOTH' ? 'Normal operations — agents observe only'
                : mode === 'SEED SCENARIO' ? 'Load historical data into graph'
                : mode === 'PLAY SCENARIO' ? 'Live replay — 10min timed events with drama'
                : 'Issues injected — agents escalate and ask humans'}
            </p>
            {seedStatus && (
              <div className="mt-2">
                {seedStatus.status === 'IN_PROGRESS' && (() => {
                  const pct = seedStatus.totalTarget ? Math.round(seedStatus.itemCount / seedStatus.totalTarget * 100) : 0;
                  const ago = seedStatus.updatedAt ? Math.round((Date.now() - new Date(seedStatus.updatedAt).getTime()) / 1000) : 0;
                  const stale = ago > 60;
                  return (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className={`text-[10px] font-mono ${stale ? 'text-status-error' : 'text-accent'}`}>
                          {stale ? 'Seed may be stuck' : 'Seeding...'} {pct}%
                        </span>
                        <span className="text-[10px] font-mono text-text-muted">
                          {seedStatus.itemCount}/{seedStatus.totalTarget || '?'}
                          <span className={stale ? 'text-status-error ml-1' : 'ml-1'}>({ago}s ago)</span>
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-surface-tertiary rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-500 ${stale ? 'bg-status-error' : 'bg-accent'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      {stale && (
                        <button
                          onClick={async () => {
                            await callHitl('clear-scenario-lock');
                            setSeedStatus(null);
                          }}
                          className="mt-1.5 text-[9px] font-mono text-status-error hover:underline"
                        >
                          Force unlock &amp; retry
                        </button>
                      )}
                    </div>
                  );
                })()}
                {seedStatus.status === 'COMPLETED' && (
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-status-success" />
                    <span className="text-[10px] font-mono text-status-success">
                      Seeded {seedStatus.itemCount} items
                    </span>
                  </div>
                )}
                {seedStatus.status === 'FAILED' && (
                  <div className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-status-error" />
                    <span className="text-[10px] font-mono text-status-error">Seed failed</span>
                    <button
                      onClick={async () => {
                        await callHitl('clear-scenario-lock');
                        setSeedStatus(null);
                      }}
                      className="text-[9px] font-mono text-status-error hover:underline ml-2"
                    >
                      Clear &amp; retry
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="flex gap-2 mb-4">
            <button
              onClick={handleStartGen}
              disabled={genAction || genStatus === 'RUNNING'}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-[11px] font-mono font-bold uppercase rounded-lg border transition-colors bg-status-success/10 text-status-success border-status-success/30 hover:bg-status-success/20 disabled:opacity-40"
            >
              <Play size={12} /> Start
            </button>
            <button
              onClick={handleStopGen}
              disabled={genAction || genStatus === 'STOPPED'}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-[11px] font-mono font-bold uppercase rounded-lg border transition-colors bg-status-error/10 text-status-error border-status-error/30 hover:bg-status-error/20 disabled:opacity-40"
            >
              <Square size={12} /> Stop
            </button>
          </div>

          <div className="mb-4">
            <label className="text-[11px] font-mono text-text-muted block mb-2">
              Tick Interval: <strong className="text-text-primary">{tickInterval}s</strong>
            </label>
            <div className="flex gap-2">
              {[1, 5, 10, 30, 60].map((v) => (
                <button key={v} onClick={() => updateClock({ tickIntervalS: v })}
                  className={`px-3 py-1.5 text-[11px] font-mono rounded-lg border transition-colors ${
                    tickInterval === v ? 'bg-accent text-white border-accent' : 'bg-surface-secondary text-text-secondary border-border hover:bg-surface-tertiary'
                  }`}>{v}s</button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[11px] font-mono text-text-muted block mb-2">
              Event Density: <strong className="text-text-primary">{density}x</strong>
            </label>
            <div className="flex gap-2">
              {[0.3, 0.5, 1.0, 2.0, 3.0].map((v) => (
                <button key={v} onClick={() => updateClock({ eventDensity: v })}
                  className={`px-3 py-1.5 text-[11px] font-mono rounded-lg border transition-colors ${
                    density === v ? 'bg-accent text-white border-accent' : 'bg-surface-secondary text-text-secondary border-border hover:bg-surface-tertiary'
                  }`}>{v}x</button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[11px] font-mono text-text-muted block mb-2">
              Auto-stop generators: <strong className="text-text-primary">{autoStopHours > 0 ? `after ${autoStopHours}h` : 'never'}</strong>
            </label>
            <div className="flex gap-2">
              {[0, 1, 2, 4, 8].map((v) => (
                <button key={v} onClick={() => updateClock({ autoStopHours: v })}
                  className={`px-3 py-1.5 text-[11px] font-mono rounded-lg border transition-colors ${
                    autoStopHours === v ? 'bg-accent text-white border-accent' : 'bg-surface-secondary text-text-secondary border-border hover:bg-surface-tertiary'
                  }`}>{v === 0 ? 'Off' : `${v}h`}</button>
              ))}
            </div>
            <p className="text-[10px] font-mono text-text-muted mt-1.5">
              Generators scale themselves to zero after this runtime — prevents a left-running demo from bloating the graph.
            </p>
          </div>
        </ControlCard>

        {/* Phase + Reset */}
        <ControlCard title="Demo Phase" icon={<Sliders size={14} className="text-accent" />}>
          <div className="flex flex-wrap gap-2 mb-4">
            {['DESIGN', 'PRODUCTION', 'QA', 'INSERVICE'].map((p) => (
              <button key={p} onClick={() => updateClock({ phase: p })}
                className={`px-4 py-2 text-[11px] font-mono font-bold uppercase rounded-lg border transition-colors ${
                  phase === p ? 'bg-status-success text-white border-status-success' : 'bg-surface-secondary text-text-secondary border-border hover:bg-surface-tertiary'
                }`}>{p}</button>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              disabled={seeding}
              onClick={async () => {
                setSeeding(true);
                setSeedResult(null);
                try {
                  const body = await callHitl('seed-baseline');
                  setSeedResult(body.message ?? 'Seeding started');
                } catch (err: any) {
                  setSeedResult(`Error: ${err.message}`);
                } finally {
                  setTimeout(() => setSeeding(false), 3000);
                }
              }}
              className="flex items-center gap-2 px-4 py-2 text-[11px] font-mono font-bold uppercase rounded-lg border border-accent text-accent hover:bg-accent-subtle transition-colors disabled:opacity-50"
            >
              <Database size={12} />
              {seeding ? 'Seeding...' : 'Seed Baseline'}
            </button>
            <button
              disabled={resetting}
              onClick={async () => {
                if (!confirm('This will wipe ALL data (DDB, Neptune, S3) and stop generators. Continue?')) return;
                setResetting(true);
                setResetResults(null);
                try {
                  const body = await callHitl('reset-demo');
                  setResetResults(body.results ?? ['Done']);
                  clearAll();
                  refreshGenStatus();
                } catch (err: any) {
                  setResetResults([`Error: ${err.message}`]);
                } finally {
                  setResetting(false);
                }
              }}
              className="flex items-center gap-2 px-4 py-2 text-[11px] font-mono font-bold uppercase rounded-lg border border-status-error text-status-error hover:bg-status-error-subtle transition-colors disabled:opacity-50"
            >
              <RotateCcw size={12} className={resetting ? 'animate-spin' : ''} />
              {resetting ? 'Resetting...' : 'Reset All Data'}
            </button>
          </div>
          {seedResult && (
            <div className="mt-3 p-2 bg-accent-subtle rounded-lg">
              <p className="text-[10px] font-mono text-accent">{seedResult}</p>
            </div>
          )}
          {resetResults && (
            <div className="mt-3 p-2 bg-surface-tertiary rounded-lg max-h-[150px] overflow-y-auto">
              <p className="text-[9px] font-bold text-text-muted uppercase mb-1">Reset Results</p>
              {resetResults.map((r, i) => (
                <p key={i} className={`text-[9px] font-mono ${r.includes('error') || r.includes('failed') ? 'text-status-error' : 'text-text-secondary'}`}>{r}</p>
              ))}
            </div>
          )}
        </ControlCard>

        {/* Drama Injections */}
        <ControlCard title="Drama Injections" icon={<Zap size={14} className="text-status-warning" />}>
          <p className="text-[10px] text-text-muted mb-3">Inject scripted scenarios that trigger agent cascades</p>
          <div className="flex flex-col gap-2">
            {[
              { id: 'ncr-cluster', icon: AlertTriangle, color: 'text-status-error', title: 'NCR Cluster — Titan Forge', desc: '3 CRITICAL NCRs on P/N 44821-003 from titan-forge LOT-7731', agents: 'agent1 → agent4 → agent3' },
              { id: 'bearing-wear', icon: Gauge, color: 'text-status-warning', title: 'Bearing Wear — CNC Mill #3', desc: 'Spindle vibration escalates 1.2 → 2.1 → 2.8 mm/s', agents: 'agent6 → agent3' },
              { id: 'fleet-anomaly', icon: Plane, color: 'text-status-info', title: 'Fleet Anomaly — Hydraulic Pressure', desc: 'SN-0038 + SN-0041 correlated pressure deviation', agents: 'agent9 → agent5' },
              { id: 'supplier-otd-drop', icon: TrendingDown, color: 'text-status-error', title: 'Supplier OTD Crash — Titan Forge', desc: 'OTD drops to 55% — CRITICAL supplier risk', agents: 'agent4' },
              { id: 'kit-shortage-cascade', icon: Package, color: 'text-status-warning', title: 'Kit Shortage Cascade', desc: '3 kits SHORT blocking active work orders', agents: 'agent3' },
              { id: 'cert-gap-critical', icon: ShieldAlert, color: 'text-status-error', title: 'Cert Gap — NDT Failure', desc: 'NDT test FAIL on SN-0047 — cert package incomplete', agents: 'agent5, agent7' },
              { id: 'milestone-at-risk', icon: Target, color: 'text-status-warning', title: 'Milestone At Risk — FAI Complete', desc: 'Confidence drops to 45% — schedule at risk', agents: 'agent8' },
              { id: 'single-ncr', icon: FileWarning, color: 'text-status-warning', title: 'Single NCR — New Supplier', desc: '1 MAJOR position OOT from Precision Aero GmbH (no history)', agents: 'agent1' },
              { id: 'simple-supplier-event', icon: TrendingDown, color: 'text-text-muted', title: 'Supplier Score — Precision Aero', desc: 'OTD 78.5% score update — single agent, no cascade', agents: 'agent4 only' },
            ].map(({ id, icon: Icon, color, title, desc, agents }) => (
              <button key={id} onClick={() => handleInject(id)} disabled={!!injecting}
                className="flex items-center gap-3 px-4 py-3 text-left rounded-lg border border-border hover:bg-surface-secondary transition-colors disabled:opacity-50">
                <Icon size={16} className={`${color} shrink-0`} />
                <div className="flex-1">
                  <strong className="text-[12px] text-text-primary block">{title}</strong>
                  <span className="text-[10px] text-text-muted">{desc}</span>
                  <span className="text-[9px] text-accent block mt-0.5">{agents}</span>
                </div>
                {injecting === id && <span className="text-[10px] text-status-success font-mono">Injected</span>}
              </button>
            ))}
          </div>
        </ControlCard>

        {/* Graph DLQ */}
        <ControlCard title={`Graph Write DLQ (${dlqCount})`} icon={<Inbox size={14} className={dlqCount > 0 ? 'text-status-warning' : 'text-text-muted'} />}>
          <div className="flex gap-2 mb-3">
            <button onClick={refreshDlq} disabled={dlqLoading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono rounded-lg border border-border text-text-secondary hover:bg-surface-secondary transition-colors disabled:opacity-50">
              <RefreshCw size={10} className={dlqLoading ? 'animate-spin' : ''} /> Refresh
            </button>
            <button
              onClick={async () => {
                if (!dlqCount || !confirm(`Replay ${dlqCount} failed graph writes?`)) return;
                setReplaying(true);
                setReplayResults(null);
                try {
                  const body = await callHitl('dlq-replay');
                  setReplayResults(body.results ?? ['Done']);
                  refreshDlq();
                } catch (err: any) {
                  setReplayResults([`Error: ${err.message}`]);
                } finally {
                  setReplaying(false);
                }
              }}
              disabled={replaying || dlqCount === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-mono font-bold rounded-lg border border-status-warning text-status-warning hover:bg-status-warning-subtle transition-colors disabled:opacity-40">
              <Play size={10} /> {replaying ? 'Replaying...' : 'Replay All'}
            </button>
          </div>
          {replayResults && (
            <div className="mb-3 p-2 bg-surface-tertiary rounded-lg max-h-[100px] overflow-y-auto">
              {replayResults.map((r, i) => (
                <p key={i} className={`text-[9px] font-mono ${r.includes('FAIL') || r.includes('Error') ? 'text-status-error' : 'text-text-secondary'}`}>{r}</p>
              ))}
            </div>
          )}
          {dlqCount === 0 ? (
            <p className="text-[11px] text-text-muted font-mono text-center py-3">No failed writes</p>
          ) : (
            <div className="max-h-[200px] overflow-y-auto space-y-1">
              {dlqItems.map((item, i) => (
                <div key={i} className="px-2 py-1.5 bg-surface-secondary rounded text-[9px] font-mono">
                  <div className="flex items-center justify-between">
                    <span className="text-text-primary font-semibold">{item.nodeId || item.sk}</span>
                    <span className="text-text-muted">{item.failedAt ? new Date(item.failedAt * 1000).toLocaleTimeString() : ''}</span>
                  </div>
                  <p className="text-status-error truncate">{item.error}</p>
                </div>
              ))}
            </div>
          )}
        </ControlCard>
      </div>
    </div>
  );
}
