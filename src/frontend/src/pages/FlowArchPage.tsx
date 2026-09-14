/**
 * React Flow Architecture — mirrors the interactive architecture layout
 * with animated edges showing event flow between layers.
 */

import { useState, useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeTypes,
  Position,
  MarkerType,
  Handle,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// ─── Custom Nodes ───────────────────────────────────────────────────

function SystemNode({ data }: any) {
  return (
    <div className={`bg-surface-primary border rounded-lg px-3 py-2 shadow-sm text-center transition-all min-w-[85px] ${
      data.active ? 'border-accent ring-1 ring-accent/30' : 'border-border'
    }`}>
      <Handle type="source" position={Position.Top} className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Left} id="left-in" className="!bg-transparent !border-0 !w-0 !h-0" />
      <div className={`text-[11px] font-bold ${data.active ? 'text-accent' : 'text-[#1e3a5f]'}`}>{data.label}</div>
      <div className="text-[8px] text-text-muted font-mono">{data.sub}</div>
    </div>
  );
}

function InfraNode({ data }: any) {
  return (
    <div className={`bg-surface-primary border-[1.5px] rounded-lg px-4 py-2.5 shadow-sm text-center transition-all ${
      data.active ? 'border-accent ring-1 ring-accent/30 bg-accent-subtle/30' : 'border-border'
    }`} style={{ borderColor: data.active ? undefined : (data.color || '#c2410c') + '50' }}>
      <Handle type="target" position={Position.Bottom} className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Top} className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Left} id="left-in" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Right} id="right-in" className="!bg-transparent !border-0 !w-0 !h-0" />
      <div className={`text-[11px] font-bold ${data.active ? 'text-accent' : ''}`} style={{ color: data.active ? undefined : data.color }}>{data.label}</div>
      <div className="text-[8px] text-text-muted">{data.sub}</div>
    </div>
  );
}

function AgentNode({ data }: any) {
  const c = data.active ? data.color : '#bbb';
  return (
    <div className={`border-2 rounded-xl px-3 py-2 shadow-sm text-center transition-all min-w-[130px] ${
      data.selected ? 'ring-2 ring-accent shadow-lg scale-[1.03]' : ''
    }`} style={{ borderColor: c, background: c + '0a' }}>
      <Handle type="target" position={Position.Bottom} className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Top} className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Left} id="left" className="!bg-transparent !border-0 !w-0 !h-0" />
      <div className="text-[11px] font-bold" style={{ color: c }}>{data.label}</div>
      <div className="text-[8px] text-text-muted">{data.sub}</div>
    </div>
  );
}

function DashboardNode({ data }: any) {
  return (
    <div className={`bg-surface-primary border-[1.5px] rounded-lg px-3 py-2 shadow-sm text-center transition-all min-w-[95px] ${
      data.active ? 'border-accent ring-1 ring-accent/30' : 'border-[#0891b240]'
    }`}>
      <Handle type="target" position={Position.Bottom} className="!bg-transparent !border-0 !w-0 !h-0" />
      <div className={`text-[11px] font-bold ${data.active ? 'text-accent' : 'text-[#0891b2]'}`}>{data.label}</div>
      <div className="text-[8px] text-text-muted">{data.sub}</div>
    </div>
  );
}

function LabelNode({ data }: any) {
  return (
    <div className="text-[9px] font-bold uppercase tracking-widest px-2 py-1 rounded" style={{ color: data.color, background: data.color + '10' }}>
      {data.label}
    </div>
  );
}

function HITLNode({ data }: any) {
  return (
    <div className="bg-accent-subtle border-2 border-accent/30 rounded-full px-4 py-2 shadow-sm text-center">
      <Handle type="target" position={Position.Right} id="right-in" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Right} id="right" className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="target" position={Position.Bottom} className="!bg-transparent !border-0 !w-0 !h-0" />
      <Handle type="source" position={Position.Top} className="!bg-transparent !border-0 !w-0 !h-0" />
      <div className="text-[10px] font-bold text-accent">{data.label}</div>
      <div className="text-[8px] text-text-muted">Agents prepare, humans decide</div>
    </div>
  );
}

const nodeTypes: NodeTypes = { system: SystemNode, infra: InfraNode, agent: AgentNode, dashboard: DashboardNode, label: LabelNode, hitl: HITLNode };

// ─── Agent + System Data ────────────────────────────────────────────

const AGENT_DATA = [
  { id: 'a1', label: 'Conformance Guardian', domain: 'Quality', color: '#c2410c', usesGraph: true, usesAthena: true, dash: 'd-quality', sysList: ['QMS'], a2a: ['a4', 'a3'], writeTools: ['update_ncr_disposition'], writeSystems: ['QMS'] },
  { id: 'a2', label: 'Change Impact', domain: 'Engineering', color: '#4f46e5', usesGraph: true, usesAthena: true, dash: 'd-program', sysList: ['PLM'], a2a: [], writeTools: ['create_engineering_change'], writeSystems: ['PLM'] },
  { id: 'a3', label: 'Production Flow', domain: 'Shop Floor', color: '#0891b2', usesGraph: true, usesAthena: true, dash: 'd-shopfloor', sysList: ['MES', 'WMS'], a2a: [], writeTools: ['release_work_order_hold'], writeSystems: ['MES'] },
  { id: 'a4', label: 'Supplier Risk', domain: 'Supply Chain', color: '#c2410c', usesGraph: true, usesAthena: true, dash: 'd-supply', sysList: ['SRM', 'ERP'], a2a: [], writeTools: ['update_supplier_score'], writeSystems: ['SRM'] },
  { id: 'a5', label: 'Cert Tracker', domain: 'Compliance', color: '#059669', usesGraph: true, usesAthena: true, dash: 'd-quality', sysList: ['PLM', 'DHR'], a2a: [], writeTools: [], writeSystems: [] },
  { id: 'a6', label: 'Predictive Maint.', domain: 'Shop Floor', color: '#0891b2', usesGraph: true, usesAthena: true, dash: 'd-shopfloor', sysList: ['SCADA'], a2a: ['a3'], writeTools: [], writeSystems: [] },
  { id: 'a7', label: 'DHR Completeness', domain: 'Quality', color: '#059669', usesGraph: true, usesAthena: true, dash: 'd-quality', sysList: ['DHR'], a2a: ['a5'], writeTools: [], writeSystems: [] },
  { id: 'a8', label: 'Program Risk', domain: 'Program', color: '#4f46e5', usesGraph: true, usesAthena: true, dash: 'd-program', sysList: ['Program'], a2a: [], writeTools: ['update_milestone_status'], writeSystems: ['Program'] },
  { id: 'a9', label: 'Fleet Health', domain: 'In-Service', color: '#1e3a5f', usesGraph: true, usesAthena: true, dash: 'd-fleet', sysList: ['InService'], a2a: ['a5'], writeTools: ['log_maintenance_action'], writeSystems: ['InService'] },
  { id: 'a10', label: 'SCADA Anomaly', domain: 'Shop Floor', color: '#c2410c', usesGraph: true, usesAthena: true, dash: 'd-shopfloor', sysList: ['SCADA'], a2a: ['a6'], writeTools: [], writeSystems: [] },
];

const SYS_LIST = ['QMS', 'MES', 'PLM', 'ERP', 'SRM', 'WMS', 'DHR', 'Program', 'InService', 'SCADA'];

// ─── Build Graph ────────────────────────────────────────────────────

function buildGraph(sel: string | null) {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  const ac = { stroke: '#4f46e5', strokeWidth: 2 };
  const gr = { stroke: '#059669', strokeWidth: 1.5 };
  const at = { stroke: '#4f46e5', strokeWidth: 1.5 };
  const dim = { stroke: '#e2e0dc', strokeWidth: 1 };
  const arrow = (c: string) => ({ type: MarkerType.ArrowClosed as const, color: c, width: 10, height: 10 });

  const selAgent = sel ? AGENT_DATA.find((a) => a.id === sel) : null;
  const selCertAgent = sel === 'cert-agent';
  const selFastConsumer = sel === 'fast-consumer';
  const certActive = selCertAgent;
  const fastConsumerActive = selFastConsumer;
  const activeSys = new Set(
    selAgent?.sysList ?? (certActive ? ['QMS'] : fastConsumerActive ? SYS_LIST : []),
  );
  const activeDash = selAgent ? new Set([selAgent.dash]) : new Set<string>();
  const a2aTargets = new Set(selAgent?.a2a ?? []);

  // ── Layer positions ──
  const LX = -60;  // left margin for agents
  const CX = 200;  // center start for layers

  // Row 1: Dashboards + HITL (Y=20) — User Centric layer
  const DY = 20;
  nodes.push({ id: 'lbl-dash', type: 'label', position: { x: CX, y: DY }, data: { label: 'User Centric — Dashboards + HITL', color: '#0891b2' } });
  const dashboards = [
    { id: 'd-quality', label: 'Quality', sub: 'NCR · Activity · HITL', x: CX + 40 },
    { id: 'd-shopfloor', label: 'Shop Floor', sub: 'MQTT · OEE · WOs', x: CX + 180 },
    { id: 'd-supply', label: 'Supply Chain', sub: 'PO · kitting', x: CX + 330 },
    { id: 'd-program', label: 'Program', sub: 'milestones · EV', x: CX + 460 },
    { id: 'd-fleet', label: 'Fleet', sub: 'digital twin', x: CX + 580 },
  ];
  dashboards.forEach((d) => {
    nodes.push({ id: d.id, type: 'dashboard', position: { x: d.x, y: DY + 22 }, data: { ...d, active: activeDash.has(d.id) } });
  });

  // HITL node — far left of agents, same height as dashboards (user centric layer)
  nodes.push({ id: 'hitl', type: 'hitl', position: { x: LX - 200, y: DY + 15 }, data: { label: 'Human Decision (HITL)' } });

  // Row 2: Knowledge Graph — Neptune centered, consumers below
  const GY = 130;
  nodes.push({ id: 'lbl-graph', type: 'label', position: { x: CX, y: GY }, data: { label: 'Knowledge Graph — Digital Thread', color: '#059669' } });
  nodes.push({ id: 'neptune', type: 'infra', position: { x: CX + 200, y: GY + 22 },
    data: { label: 'Neptune Serverless', sub: 'Single Source of Truth', color: '#059669', active: (sel && selAgent?.usesGraph) || certActive || fastConsumerActive } });
  const views = ['Engineering', 'Manufacturing', 'Quality', 'Supply Chain'];
  views.forEach((v, i) => {
    nodes.push({ id: `view-${i}`, type: 'infra', position: { x: CX + 380 + i * 140, y: GY + 22 },
      data: { label: `${v} View`, sub: 'domain projection', color: '#059669', active: false } });
  });

  // Row 3: Data Service Layer — EventBridge, MSK Connect, MSK on the same row
  const DLY = 280;
  nodes.push({ id: 'lbl-data', type: 'label', position: { x: CX, y: DLY }, data: { label: 'Data Service Layer — Event Backbone', color: '#c2410c' } });

  // EventBridge, MSK Connect, MSK — all on one row
  nodes.push({ id: 'eb', type: 'infra', position: { x: CX + 30, y: DLY + 25 },
    data: { label: 'EventBridge', sub: 'aerospace-central · per-agent rules', color: '#c2410c', active: !!selAgent } });
  nodes.push({ id: 'msk-connect', type: 'infra', position: { x: CX + 220, y: DLY + 25 },
    data: { label: 'MSK Connect', sub: 'EventBridge Sink', color: '#c2410c', active: !!selAgent } });
  nodes.push({ id: 'msk', type: 'infra', position: { x: CX + 400, y: DLY + 25 },
    data: { label: 'MSK Provisioned', sub: '11 topics · Kafka 3.5.1', color: '#c2410c', active: !!selAgent || certActive || fastConsumerActive } });

  // ISA-95 Normalizer — legacy ERP/PLM publish native vendor vocab to *.raw topics;
  // this MSK→MSK Lambda maps to ISA-95 and republishes to canonical *.events topics
  // (so graph + datalake + agents all consume ISA-95).
  nodes.push({ id: 'normalizer', type: 'infra', position: { x: CX + 400, y: DLY + 78 },
    data: { label: 'ISA-95 Normalizer', sub: 'ERP/PLM raw → ISA-95 canonical', color: '#c2410c', active: !!selAgent || fastConsumerActive } });
  const normActive = !!selAgent || fastConsumerActive;
  const normStyle = normActive ? { stroke: '#c2410c', strokeWidth: 1.5, strokeDasharray: '5 3' } : dim;
  edges.push({ id: 'msk-normalizer', source: 'msk', target: 'normalizer',
    animated: normActive, style: normStyle,
    label: 'raw', labelStyle: { fontSize: 7, fill: '#c2410c' },
    markerEnd: arrow(normActive ? '#c2410c' : '#e2e0dc') });
  edges.push({ id: 'normalizer-msk', source: 'normalizer', target: 'msk',
    animated: normActive, style: normStyle,
    label: 'ISA-95', labelStyle: { fontSize: 7, fill: '#c2410c' },
    markerEnd: arrow(normActive ? '#c2410c' : '#e2e0dc') });

  // Athena + Firehose on the right, stacked
  nodes.push({ id: 'athena', type: 'infra', position: { x: CX + 600, y: DLY + 15 },
    data: { label: 'Athena + Iceberg', sub: 'SQL analytics · parquet', color: '#4f46e5', active: sel && selAgent?.usesAthena } });
  nodes.push({ id: 'firehose', type: 'infra', position: { x: CX + 600, y: DLY + 65 },
    data: { label: 'Kinesis Firehose', sub: 'MSK consumer → S3', color: '#4f46e5', active: !!selAgent } });

  // Data layer edges: MSK → MSK Connect → EventBridge (event routing path)
  edges.push({ id: 'msk-connect-e', source: 'msk', sourceHandle: 'left', target: 'msk-connect', targetHandle: 'right-in',
    animated: !!selAgent, style: selAgent ? ac : dim, markerEnd: arrow(selAgent ? '#4f46e5' : '#e2e0dc') });
  edges.push({ id: 'connect-eb', source: 'msk-connect', sourceHandle: 'left', target: 'eb', targetHandle: 'right-in',
    animated: !!selAgent, style: selAgent ? ac : dim, markerEnd: arrow(selAgent ? '#4f46e5' : '#e2e0dc') });
  // MSK → Firehose → Athena (datalake path — only highlighted when selected agent uses Athena)
  const athenaActive = sel && selAgent?.usesAthena;
  edges.push({ id: 'msk-firehose', source: 'msk', target: 'firehose', sourceHandle: 'right', targetHandle: 'left-in',
    animated: !!athenaActive, style: athenaActive ? { stroke: '#4f46e5', strokeWidth: 1.5 } : dim,
    markerEnd: arrow(athenaActive ? '#4f46e5' : '#e2e0dc') });
  edges.push({ id: 'firehose-athena', source: 'firehose', target: 'athena',
    animated: !!athenaActive, style: athenaActive ? { stroke: '#4f46e5', strokeWidth: 1.5 } : dim,
    markerEnd: arrow(athenaActive ? '#4f46e5' : '#e2e0dc') });

  // Digital Thread Consumers — between MSK and Neptune
  const graphActive = sel && selAgent?.usesGraph;

  // Fast Consumer + Cert Agent — side by side below Neptune
  nodes.push({ id: 'fast-consumer', type: 'infra', position: { x: CX + 100, y: GY + 80 },
    data: { label: 'Fast Consumer', sub: 'ECS · graph writer · 10 topics', color: '#059669', active: !sel || !!graphActive || fastConsumerActive } });
  // MSK → Fast Consumer → Neptune (animated when graph-using agent OR cert agent selected)
  const gc = { stroke: '#059669', strokeWidth: 1.5 };
  const fastActive = graphActive || fastConsumerActive;
  edges.push({ id: 'msk-fast', source: 'msk', target: 'fast-consumer',
    animated: !!fastActive, style: fastActive ? gc : dim,
    label: 'all 10 topics', labelStyle: { fontSize: 7, fill: '#059669' },
    markerEnd: arrow(fastActive ? '#059669' : '#e2e0dc') });
  edges.push({ id: 'fast-neptune', source: 'fast-consumer', target: 'neptune',
    animated: !!fastActive, style: fastActive ? gc : dim,
    label: '16 node types', labelStyle: { fontSize: 7, fill: '#059669' },
    markerEnd: arrow(fastActive ? '#059669' : '#e2e0dc') });

  // Cert Readiness Agent — beside Fast Consumer, below Neptune
  nodes.push({ id: 'cert-agent', type: 'agent', position: { x: CX + 310, y: GY + 80 },
    data: { label: 'Cert Readiness Agent', sub: 'ECS · Strands · Bedrock', color: '#059669', active: !sel || !!graphActive || certActive, selected: selCertAgent } });
  // MSK (QMS topic) → Cert Readiness Agent → Neptune (dashed = async/Bedrock)
  const gcd = { stroke: '#059669', strokeWidth: 1.5, strokeDasharray: '6 3' };
  const certEdgeActive = certActive;
  edges.push({ id: 'msk-cert-agent', source: 'msk', target: 'cert-agent',
    animated: !!certEdgeActive, style: certEdgeActive ? gcd : dim,
    label: 'QMS topic', labelStyle: { fontSize: 7, fill: '#059669' },
    markerEnd: arrow(certEdgeActive ? '#059669' : '#e2e0dc') });
  edges.push({ id: 'cert-agent-neptune', source: 'cert-agent', target: 'neptune',
    animated: !!certEdgeActive, style: certEdgeActive ? gcd : dim,
    label: 'verdicts + gaps', labelStyle: { fontSize: 7, fill: '#059669' },
    markerEnd: arrow(certEdgeActive ? '#059669' : '#e2e0dc') });

  // Row 4: Source Systems (Y=420)
  const SY = 420;

  // Gateway node — below EventBridge (EventBridge is at CX+30, DLY+25)
  const hasWrite = selAgent && selAgent.writeTools.length > 0;
  nodes.push({ id: 'gateway', type: 'infra', position: { x: CX + 30, y: DLY + 75 },
    data: { label: 'AgentCore Gateway', sub: 'MCP → REST API', color: '#7c3aed', active: !!hasWrite } });

  nodes.push({ id: 'lbl-sys', type: 'label', position: { x: CX, y: SY }, data: { label: 'System of Records — 10 Source Systems', color: '#1e3a5f' } });
  SYS_LIST.forEach((s, i) => {
    const x = CX + 10 + i * 82;
    const active = !sel || activeSys.has(s);
    nodes.push({ id: `sys-${s}`, type: 'system', position: { x, y: SY + 22 }, data: { label: s, sub: s === 'SCADA' ? 'IoT Core' : `${s.toLowerCase()}-demo`, active } });
    // System → MSK
    edges.push({ id: `sys-${s}-msk`, source: `sys-${s}`, target: 'msk',
      animated: active && !!sel, style: active && sel ? ac : dim,
      markerEnd: arrow(active && sel ? '#4f46e5' : '#e2e0dc') });
  });

  // ── Agents (left column, Y spread to match layers) ──
  nodes.push({ id: 'lbl-agents', type: 'label', position: { x: LX, y: DY }, data: { label: 'AgentCore Runtime', color: '#0891b2' } });

  // AWS Agent Registry — agents discover + resolve peers here before an A2A call
  const anyA2A = !!(selAgent && selAgent.a2a.length > 0);
  nodes.push({ id: 'agent-registry', type: 'infra', position: { x: LX, y: DY + 30 + AGENT_DATA.length * 54 + 16 },
    data: { label: 'AWS Agent Registry', sub: 'semantic discovery · ARN resolve', color: '#0891b2', active: !sel || anyA2A } });

  AGENT_DATA.forEach((a, i) => {
    const y = DY + 30 + i * 54;
    const isSelected = sel === a.id;
    const isA2ATarget = a2aTargets.has(a.id);
    const active = !sel || isSelected || isA2ATarget;
    nodes.push({ id: a.id, type: 'agent', position: { x: LX, y },
      data: { label: a.label, sub: a.domain, color: a.color, active, selected: isSelected } });

    // EventBridge → Agent (trigger)
    edges.push({ id: `eb-${a.id}`, source: 'eb', target: a.id, sourceHandle: 'left', targetHandle: undefined,
      animated: active && !!sel, style: active && sel ? ac : dim,
      markerEnd: arrow(active && sel ? '#4f46e5' : '#e2e0dc') });

    // Agent → Neptune (query)
    if (a.usesGraph) {
      edges.push({ id: `${a.id}-neptune`, source: a.id, target: 'neptune', sourceHandle: 'right', targetHandle: 'left-in',
        animated: sel === a.id, style: sel === a.id ? gr : dim,
        label: sel === a.id ? 'query' : '', labelStyle: { fontSize: 7, fill: '#059669' } });
    }

    // Agent → Athena (query)
    if (a.usesAthena) {
      edges.push({ id: `${a.id}-athena`, source: a.id, target: 'athena', sourceHandle: 'right', targetHandle: 'left-in',
        animated: sel === a.id, style: sel === a.id ? at : dim,
        label: sel === a.id ? 'trends' : '', labelStyle: { fontSize: 7, fill: '#4f46e5' } });
    }

    // Agent ↔ HITL (ask_human / resume) — short edges via left handles
    if (sel === a.id) {
      edges.push({ id: `${a.id}-hitl`, source: a.id, target: 'hitl', targetHandle: 'right-in',
        animated: true, style: { stroke: '#4f46e5', strokeWidth: 2, strokeDasharray: '6 3' },
        label: 'ask_human', labelStyle: { fontSize: 8, fill: '#4f46e5', fontWeight: 700 },
        markerEnd: arrow('#4f46e5') });
      edges.push({ id: `hitl-${a.id}`, source: 'hitl', target: a.id, sourceHandle: 'right', targetHandle: 'left',
        animated: true, style: { stroke: '#059669', strokeWidth: 2, strokeDasharray: '6 3' },
        label: 'resume', labelStyle: { fontSize: 8, fill: '#059669', fontWeight: 700 },
        markerEnd: arrow('#059669') });
    }

    // Agent → Dashboard (finding)
    edges.push({ id: `${a.id}-dash`, source: a.id, target: a.dash,
      animated: active && !!sel, style: active && sel ? { stroke: '#059669', strokeWidth: 1.5 } : dim,
      markerEnd: arrow(active && sel ? '#059669' : '#e2e0dc') });

    // Agent → Agent (A2A calls — only shown when source agent selected)
    if (sel === a.id && a.a2a.length > 0) {
      // First the agent discovers + resolves the peer's ARN via the AWS Agent Registry
      edges.push({ id: `${a.id}-registry`, source: a.id, target: 'agent-registry', sourceHandle: 'right', targetHandle: 'right-in',
        animated: true,
        style: { stroke: '#0891b2', strokeWidth: 2, strokeDasharray: '4 3' },
        label: 'discover', labelStyle: { fontSize: 8, fill: '#0891b2', fontWeight: 700 },
        markerEnd: arrow('#0891b2') });
      a.a2a.forEach((targetId) => {
        edges.push({ id: `${a.id}-a2a-${targetId}`, source: a.id, target: targetId,
          animated: true,
          style: { stroke: '#0891b2', strokeWidth: 2.5, strokeDasharray: '8 4' },
          label: 'A2A call', labelStyle: { fontSize: 8, fill: '#0891b2', fontWeight: 700 },
          markerEnd: arrow('#0891b2') });
      });
    }

    // Agent (right) → Gateway (left-in) then Gateway (right) → Source System
    if (sel === a.id && a.writeSystems.length > 0) {
      edges.push({ id: `${a.id}-gateway`, source: a.id, sourceHandle: 'right', target: 'gateway', targetHandle: 'left-in',
        animated: true,
        style: { stroke: '#7c3aed', strokeWidth: 2, strokeDasharray: '6 3' },
        label: 'write via MCP', labelStyle: { fontSize: 8, fill: '#7c3aed', fontWeight: 700 },
        markerEnd: arrow('#7c3aed') });
      a.writeSystems.forEach((sysName) => {
        edges.push({ id: `gateway-${sysName}-${a.id}`, source: 'gateway', sourceHandle: 'right', target: `sys-${sysName}`,
          animated: true,
          style: { stroke: '#7c3aed', strokeWidth: 1.5 },
          label: 'write-back', labelStyle: { fontSize: 7, fill: '#7c3aed' },
          markerEnd: arrow('#7c3aed') });
      });
    }
  });

  // ── AG-UI conversational agents (user-facing, browser-direct SSE — not event-triggered) ──
  // They don't sit on the event path: the browser calls them directly and they query the
  // graph + lake, streaming widgets back. Shown top-right, above the dashboards.
  const aguiColor = '#7c3aed';
  nodes.push({ id: 'lbl-agui', type: 'label', position: { x: CX + 730, y: DY }, data: { label: 'AG-UI — Conversational', color: aguiColor } });
  nodes.push({ id: 'agui-analytics', type: 'infra', position: { x: CX + 730, y: DY + 22 },
    data: { label: 'Analytics Agent', sub: 'text-to-SQL · Athena → widgets', color: aguiColor, active: true } });
  nodes.push({ id: 'agui-navigator', type: 'infra', position: { x: CX + 730, y: DY + 78 },
    data: { label: 'Thread Navigator', sub: 'graph + lake → highlight · drawing', color: aguiColor, active: true } });
  const aguiStyle = { stroke: aguiColor, strokeWidth: 1.5, strokeDasharray: '5 3' };
  edges.push({ id: 'agui-nav-neptune', source: 'agui-navigator', sourceHandle: 'left', target: 'neptune', targetHandle: 'right-in',
    style: aguiStyle, label: 'traverse', labelStyle: { fontSize: 7, fill: aguiColor }, markerEnd: arrow(aguiColor) });
  edges.push({ id: 'agui-nav-athena', source: 'agui-navigator', sourceHandle: 'left', target: 'athena', targetHandle: 'right-in',
    style: aguiStyle, label: 'SQL', labelStyle: { fontSize: 7, fill: aguiColor }, markerEnd: arrow(aguiColor) });
  edges.push({ id: 'agui-an-athena', source: 'agui-analytics', sourceHandle: 'left', target: 'athena', targetHandle: 'right-in',
    style: aguiStyle, label: 'SQL', labelStyle: { fontSize: 7, fill: aguiColor }, markerEnd: arrow(aguiColor) });

  return { nodes, edges };
}

// ─── Main ───────────────────────────────────────────────────────────

export function FlowArchPage() {
  const [sel, setSel] = useState<string | null>(null);
  const { nodes, edges } = useMemo(() => buildGraph(sel), [sel]);

  const onNodeClick = useCallback((_: any, node: Node) => {
    if (node.type === 'agent' || node.id === 'fast-consumer') setSel((p) => p === node.id ? null : node.id);
  }, []);

  const agentName = sel === 'cert-agent' ? 'Cert Readiness Agent' : sel === 'fast-consumer' ? 'Fast Consumer' : sel ? AGENT_DATA.find((a) => a.id === sel)?.label : null;

  return (
    <div className="h-[calc(100vh-48px)] flex flex-col">
      <div className="px-5 py-2.5 border-b border-border bg-surface-primary flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-[14px] font-bold text-text-primary">Event Flow Architecture</h2>
          <p className="text-[10px] text-text-muted">Click any agent to animate its event flow. Scroll to zoom. Drag to pan.</p>
        </div>
        {agentName && (
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold text-accent">{agentName}</span>
            <button onClick={() => setSel(null)} className="text-[10px] text-text-muted hover:text-text-primary px-2 py-0.5 rounded border border-border">Clear</button>
          </div>
        )}
      </div>
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          onPaneClick={() => setSel(null)}
          fitView
          fitViewOptions={{ padding: 0.1 }}
          minZoom={0.3}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="#e2e0dc" gap={24} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(n) => {
              if (n.type === 'agent') return (n.data as any).color || '#0891b2';
              if (n.type === 'dashboard') return '#0891b2';
              if (n.type === 'system') return '#1e3a5f';
              if (n.type === 'hitl') return '#4f46e5';
              return '#c2410c';
            }}
            style={{ background: '#f5f3ef' }}
          />
        </ReactFlow>
      </div>
    </div>
  );
}
