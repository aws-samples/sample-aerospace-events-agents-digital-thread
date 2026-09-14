/**
 * Interactive Architecture Diagram — layered enterprise view with clickable nodes.
 * Combines the static architecture layout with interactive agent/system/dashboard details.
 */

import { useState } from 'react';
import { Bot, Database, Monitor, ArrowDown, ArrowRight, Zap, MessageSquare, FileText, X, Shield, Activity, Layers, BarChart3 } from 'lucide-react';

// ─── Data Model ─────────────────────────────────────────────────────

type Agent = {
  id: string; name: string; domain: string; color: string;
  triggers: string[]; dataQueries: string[]; hitlActions: string[]; findings: string[];
  description: string;
  usesGraph: boolean;   // queries Neptune
  usesAthena: boolean;  // queries Athena/Iceberg
  a2aTargets: Array<{ target: string; reason: string }>;  // agent-to-agent calls
  writeActions: string[];  // Gateway write-back tools
};

type System = {
  id: string; name: string; table: string; events: string[]; consumers: string[];
};

type Dashboard = {
  id: string; name: string; agents: string[]; channel: string;
};

const AGENTS: Agent[] = [
  { id: 'agent1', name: 'Conformance Guardian', domain: 'Quality', color: '#c2410c',
    triggers: ['NON_CONFORMANCE_RAISED', 'NCR_DISPOSITIONED'],
    dataQueries: ['Neptune: NCR context, part, supplier', 'Athena: 7-day NCR trends by supplier'],
    hitlActions: ['Escalate MAJOR/CRITICAL NCRs', 'Recommend CAPA + lot quarantine', 'Route to MRB for flight-critical parts'],
    findings: ['Pattern: 3+ NCRs same supplier', 'MONITOR: isolated MINOR', 'ESCALATE: flight-critical bore OOT'],
    description: 'Detects NCR patterns, analyzes supplier quality trends, escalates when intervention needed.',
    usesGraph: true, usesAthena: true,
    a2aTargets: [{ target: 'agent4', reason: 'Pattern detected on supplier' }, { target: 'agent3', reason: 'CRITICAL NCR on active WO' }],
    writeActions: ['update_ncr_disposition'] },
  { id: 'agent2', name: 'Change Impact Analyst', domain: 'Engineering', color: '#4f46e5',
    triggers: ['ECO_INITIATED', 'DRAWING_RELEASED', 'BOM_REVISED'],
    dataQueries: ['Neptune: affected parts, ECOs, drawings (traverse)', 'Athena: NCR history by part'],
    hitlActions: ['Propose WO holds', 'Recommend effectivity range', 'Flag ITAR parts'],
    findings: ['BOM blast radius: N assemblies', 'N open WOs need hold review'],
    description: 'Analyzes engineering changes and identifies downstream impact.',
    usesGraph: true, usesAthena: true, a2aTargets: [], writeActions: ['create_engineering_change'] },
  { id: 'agent3', name: 'Production Flow Optimizer', domain: 'Shop Floor', color: '#0891b2',
    triggers: ['HOLD_PLACED', 'KIT_SHORTAGE_DETECTED', 'WORK_ORDER_STARTED'],
    dataQueries: ['Neptune: WOs on machine, kit → lot links', 'Athena: WO trends + hold impact'],
    hitlActions: ['Propose alternate routing', 'Expedite kit', 'Escalate single-source fault'],
    findings: ['Cascade risk: starvation in N hrs', 'Kit shortage blocking WO-XXX'],
    description: 'Detects cascade risks from holds and faults, recommends alternate routing.',
    usesGraph: true, usesAthena: true, a2aTargets: [], writeActions: ['release_work_order_hold'] },
  { id: 'agent4', name: 'Supplier Risk Sentinel', domain: 'Supply Chain', color: '#c2410c',
    triggers: ['SUPPLIER_OTD_DEGRADED', 'MATERIAL_RECEIVED', 'SUPPLIER_SCORE_UPDATED'],
    dataQueries: ['Athena: 30-day supplier OTD + NCR', 'Neptune: supplier-part-lot links'],
    hitlActions: ['Dual-source evaluation', 'Safety stock increase', 'Escalate CRITICAL supplier'],
    findings: ['Supplier risk HIGH: OTD 62%', 'titan-forge LOT-7731 flagged'],
    description: 'Monitors supplier performance, detects OTD degradation and quality trends.',
    usesGraph: true, usesAthena: true, a2aTargets: [], writeActions: ['update_supplier_score'] },
  { id: 'agent5', name: 'Certification Tracker', domain: 'Compliance', color: '#059669',
    triggers: ['DRAWING_RELEASED', 'CERT_LINKED', 'TEST_RECORDED'],
    dataQueries: ['Neptune: certs + tests on SN, ThreadGaps, verdicts', 'Athena: cert event history'],
    hitlActions: ['Route DER review package', 'Chase missing certs', 'Escalate low confidence'],
    findings: ['DO-178C gap: missing evidence', 'Cert readiness 89% — 2 gaps'],
    description: 'Monitors compliance against DO-178C, AS9100, FAR-21.',
    usesGraph: true, usesAthena: true, a2aTargets: [], writeActions: [] },
  { id: 'agent6', name: 'Predictive Maintenance', domain: 'Shop Floor', color: '#0891b2',
    triggers: ['PARAMETER_ANOMALY', 'MACHINE_FAULT', 'OEE_THRESHOLD_BREACHED'],
    dataQueries: ['Neptune: machine node + WOs on machine', 'Athena: machine fault history'],
    hitlActions: ['Propose predictive WO', 'Recommend shutdown if imminent'],
    findings: ['BEARING_WEAR on cnc-mill-3', 'Vibration 2.1mm/s — WO recommended'],
    description: 'Monitors machine telemetry, predicts failures before they disrupt production.',
    usesGraph: true, usesAthena: true, a2aTargets: [{ target: 'agent3', reason: 'Bearing failure — reroute needed' }], writeActions: [] },
  { id: 'agent7', name: 'DHR Completeness', domain: 'Quality', color: '#059669',
    triggers: ['OP_SIGNED', 'CERT_LINKED', 'TEST_RECORDED'],
    dataQueries: ['Neptune: SN → certs, tests, ops (count_by_type)', 'Athena: cert + test event history'],
    hitlActions: ['Route missing ops to shop floor', 'URGENT: ship < 7 days'],
    findings: ['DHR 85% — missing Op-70', 'AT_RISK: ship in 12 days'],
    description: 'Maintains real-time DHR completeness for every serial number.',
    usesGraph: true, usesAthena: true, a2aTargets: [{ target: 'agent5', reason: 'DHR gap affects cert package' }], writeActions: [] },
  { id: 'agent8', name: 'Program Risk Agent', domain: 'Program', color: '#4f46e5',
    triggers: ['MILESTONE_AT_RISK', 'EV_UPDATED'],
    dataQueries: ['Neptune: milestones (query_by_type)', 'Athena: SPI/CPI + milestone history'],
    hitlActions: ['Present variance analysis', 'Recommend recovery plan'],
    findings: ['SPI 0.87 — schedule behind', 'Milestone confidence 65%'],
    description: 'Monitors program health through milestones and earned value metrics.',
    usesGraph: true, usesAthena: true, a2aTargets: [], writeActions: ['update_milestone_status'] },
  { id: 'agent9', name: 'Fleet Health Agent', domain: 'In-Service', color: '#1e3a5f',
    triggers: ['PARAMETER_DEVIATION', 'ANOMALY_DETECTED'],
    dataQueries: ['Neptune: DigitalTwin + FleetAnomaly, lot → SN genealogy', 'Athena: fleet anomaly history'],
    hitlActions: ['Recommend fleet advisory', 'Propose service bulletin'],
    findings: ['Hydraulic anomaly SN-0038', 'Correlated: SN-0038 + SN-0041'],
    description: 'Monitors in-service fleet digital twin data, detects parameter deviations.',
    usesGraph: true, usesAthena: true, a2aTargets: [{ target: 'agent5', reason: 'Lot correlation found' }], writeActions: ['log_maintenance_action'] },
  { id: 'agent10', name: 'SCADA Anomaly Agent', domain: 'Shop Floor', color: '#c2410c',
    triggers: ['MACHINE_FAULT', 'OEE_THRESHOLD_BREACHED'],
    dataQueries: ['Neptune: machine node + WOs on machine', 'Athena: machine event history'],
    hitlActions: ['Recommend rerouting', 'Escalate single-source fault'],
    findings: ['cnc-mill-3 FAULT — 3 WOs affected', 'OEE 68% — below threshold'],
    description: 'Responds to SCADA events with immediate impact assessment.',
    usesGraph: true, usesAthena: true, a2aTargets: [{ target: 'agent6', reason: 'Recurring fault pattern' }], writeActions: [] },
];

const SYSTEMS: System[] = [
  { id: 'qms', name: 'QMS', table: 'qms-demo', events: ['NON_CONFORMANCE_RAISED', 'NCR_DISPOSITIONED', 'CAPA_OPENED'], consumers: ['agent1', 'agent4'] },
  { id: 'mes', name: 'MES', table: 'mes-demo', events: ['WORK_ORDER_STARTED', 'HOLD_PLACED', 'OPERATION_COMPLETED'], consumers: ['agent3'] },
  { id: 'plm', name: 'PLM', table: 'plm-demo', events: ['ECO_INITIATED', 'DRAWING_RELEASED', 'PART_RELEASED'], consumers: ['agent2', 'agent5'] },
  { id: 'erp', name: 'ERP', table: 'erp-demo', events: ['PO_ISSUED', 'MATERIAL_RECEIVED'], consumers: ['agent4'] },
  { id: 'srm', name: 'SRM', table: 'srm-demo', events: ['SUPPLIER_SCORE_UPDATED', 'SUPPLIER_OTD_DEGRADED'], consumers: ['agent4'] },
  { id: 'wms', name: 'WMS', table: 'wms-demo', events: ['KIT_STAGED', 'KIT_SHORTAGE_DETECTED'], consumers: ['agent3'] },
  { id: 'dhr', name: 'DHR', table: 'dhr-demo', events: ['CERT_LINKED', 'TEST_RECORDED', 'OPERATION_SIGNED'], consumers: ['agent5', 'agent7'] },
  { id: 'program', name: 'Program', table: 'program-demo', events: ['MILESTONE_AT_RISK', 'EV_UPDATED'], consumers: ['agent8'] },
  { id: 'inservice', name: 'In-Service', table: 'inservice-demo', events: ['PARAMETER_DEVIATION', 'ANOMALY_DETECTED'], consumers: ['agent9'] },
  { id: 'scada', name: 'SCADA', table: 'IoT Core', events: ['MACHINE_FAULT', 'PARAMETER_ANOMALY'], consumers: ['agent6', 'agent10'] },
];

const DASHBOARDS: Dashboard[] = [
  { id: 'quality', name: 'Quality', agents: ['agent1', 'agent5', 'agent7'], channel: 'quality' },
  { id: 'shop-floor', name: 'Shop Floor', agents: ['agent3', 'agent6', 'agent10'], channel: 'shop-floor' },
  { id: 'supply-chain', name: 'Supply Chain', agents: ['agent4'], channel: 'supply-chain' },
  { id: 'program', name: 'Program', agents: ['agent2', 'agent8'], channel: 'program' },
  { id: 'fleet', name: 'Fleet', agents: ['agent9'], channel: 'in-service' },
];

// ─── Selection + Highlighting ───────────────────────────────────────

type Selection = { type: 'agent' | 'system' | 'dashboard'; id: string } | null;

function useHighlights(selection: Selection) {
  const agents = new Set<string>();
  const systems = new Set<string>();
  const dashboards = new Set<string>();
  // Infrastructure layer highlights
  let msk = false;
  let eventbridge = false;
  let neptune = false;
  let athena = false;
  let dataFlow = false; // arrows between layers
  let gateway = false;
  let registry = false; // AWS Agent Registry — lit when selected agent discovers peers

  if (selection?.type === 'agent') {
    const agent = AGENTS.find((a) => a.id === selection.id);
    agents.add(selection.id);
    SYSTEMS.filter((s) => s.consumers.includes(selection.id)).forEach((s) => systems.add(s.id));
    DASHBOARDS.filter((d) => d.agents.includes(selection.id)).forEach((d) => dashboards.add(d.id));
    // Highlight A2A target agents — discovered + resolved via the AWS Agent Registry
    agent?.a2aTargets.forEach((t) => agents.add(t.target));
    if (agent && agent.a2aTargets.length > 0) registry = true;
    // Agent is triggered via EventBridge → SQS, events come from MSK
    msk = true;
    eventbridge = true;
    dataFlow = true;
    if (agent?.usesGraph) neptune = true;
    if (agent?.usesAthena) athena = true;
    if (agent?.writeActions && agent.writeActions.length > 0) gateway = true;
  } else if (selection?.type === 'system') {
    systems.add(selection.id);
    const sys = SYSTEMS.find((s) => s.id === selection.id);
    sys?.consumers.forEach((a) => {
      agents.add(a);
      DASHBOARDS.filter((d) => d.agents.includes(a)).forEach((d) => dashboards.add(d.id));
    });
    // System events flow through MSK + EventBridge
    msk = true;
    eventbridge = true;
    dataFlow = true;
  } else if (selection?.type === 'dashboard') {
    dashboards.add(selection.id);
    const dash = DASHBOARDS.find((d) => d.id === selection.id);
    dash?.agents.forEach((a) => {
      agents.add(a);
      SYSTEMS.filter((s) => s.consumers.includes(a)).forEach((s) => systems.add(s.id));
    });
    dataFlow = true;
  }
  return { agents, systems, dashboards, msk, eventbridge, neptune, athena, dataFlow, gateway, registry };
}

// ─── Shared Styles ──────────────────────────────────────────────────

const nodeBase = 'px-3 py-2 rounded-lg border text-center transition-all cursor-pointer';
const selected = 'ring-2 ring-accent shadow-lg scale-[1.02]';
const highlighted = 'border-accent/40 bg-accent-subtle/50';
const normal = 'border-border bg-surface-primary hover:bg-surface-secondary';

function cls(isSel: boolean, isHi: boolean) {
  return `${nodeBase} ${isSel ? selected : isHi ? highlighted : normal}`;
}

// ─── Flow Arrow ─────────────────────────────────────────────────────

function FlowArrow({ label, active }: { label: string; active?: boolean }) {
  return (
    <div className={`flex flex-col items-center py-1 transition-all ${active ? 'text-accent' : 'text-text-muted'}`}>
      <div className={`w-px h-3 ${active ? 'bg-accent' : 'bg-border'}`} />
      <span className={`text-[8px] font-mono tracking-wide my-0.5 ${active ? 'font-bold text-accent' : ''}`}>{label}</span>
      <ArrowDown size={10} className={active ? 'text-accent' : 'text-border'} />
    </div>
  );
}

// ─── Layer Label ────────────────────────────────────────────────────

function LayerBox({ label, color, children }: { label: string; color: string; children: React.ReactNode }) {
  return (
    <div className="relative rounded-xl border-[1.5px] p-4 pt-6 transition-all"
      style={{ borderColor: color + '40', background: color + '08' }}>
      <span className="absolute -top-2.5 left-3 px-2 text-[9px] font-bold uppercase tracking-widest bg-surface-app rounded"
        style={{ color }}>{label}</span>
      {children}
    </div>
  );
}

// ─── Detail Panel ───────────────────────────────────────────────────

function DetailPanel({ selection, onClose }: { selection: Selection; onClose: () => void }) {
  if (!selection) return null;

  if (selection.type === 'agent') {
    const agent = AGENTS.find((a) => a.id === selection.id)!;
    const sys = SYSTEMS.filter((s) => s.consumers.includes(agent.id));
    const dash = DASHBOARDS.filter((d) => d.agents.includes(agent.id));
    return (
      <div className="bg-surface-primary border border-border rounded-xl p-4 shadow-lg animate-[fade-in_0.15s_ease-out]">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="text-[14px] font-bold" style={{ color: agent.color }}>{agent.name}</h3>
            <p className="text-[10px] text-text-muted">{agent.description}</p>
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={14} /></button>
        </div>
        <div className={`grid ${agent.writeActions.length > 0 ? 'grid-cols-5' : 'grid-cols-4'} gap-3`}>
          <div>
            <div className="flex items-center gap-1 mb-1"><Zap size={10} className="text-status-warning" /><h4 className="text-[9px] font-bold uppercase">Triggers</h4></div>
            {agent.triggers.map((t) => <div key={t} className="text-[9px] font-mono px-1.5 py-0.5 mb-0.5 bg-status-warning-subtle text-status-warning-text rounded">{t}</div>)}
            <div className="text-[8px] text-text-muted mt-1">From: {sys.map((s) => s.name).join(', ')}</div>
          </div>
          <div>
            <div className="flex items-center gap-1 mb-1"><Database size={10} className="text-status-info" /><h4 className="text-[9px] font-bold uppercase">Data</h4></div>
            {agent.dataQueries.map((d, i) => <div key={i} className="text-[9px] px-1.5 py-0.5 mb-0.5 bg-surface-secondary rounded">{d}</div>)}
          </div>
          <div>
            <div className="flex items-center gap-1 mb-1"><MessageSquare size={10} className="text-accent" /><h4 className="text-[9px] font-bold uppercase">HITL</h4></div>
            {agent.hitlActions.map((h, i) => <div key={i} className="text-[9px] px-1.5 py-0.5 mb-0.5 bg-accent-subtle text-accent rounded">{h}</div>)}
          </div>
          <div>
            <div className="flex items-center gap-1 mb-1"><FileText size={10} className="text-status-success" /><h4 className="text-[9px] font-bold uppercase">Findings</h4></div>
            {agent.findings.map((f, i) => <div key={i} className="text-[9px] px-1.5 py-0.5 mb-0.5 bg-status-success-subtle text-status-success rounded">{f}</div>)}
            <div className="text-[8px] text-text-muted mt-1">On: {dash.map((d) => d.name).join(', ')}</div>
          </div>
          {agent.writeActions.length > 0 && (
            <div>
              <div className="flex items-center gap-1 mb-1"><Layers size={10} style={{ color: '#7c3aed' }} /><h4 className="text-[9px] font-bold uppercase">Write-Back</h4></div>
              {agent.writeActions.map((w, i) => <div key={i} className="text-[9px] font-mono px-1.5 py-0.5 mb-0.5 rounded" style={{ background: '#7c3aed15', color: '#7c3aed' }}>{w}</div>)}
              <div className="text-[8px] text-text-muted mt-1">Via AgentCore Gateway</div>
            </div>
          )}
        </div>
        {agent.a2aTargets.length > 0 && (
          <div className="mt-3 pt-2 border-t border-border">
            <div className="flex items-center gap-1 mb-1"><Bot size={10} className="text-[#0891b2]" /><h4 className="text-[9px] font-bold uppercase">A2A Agent-to-Agent Calls</h4></div>
            <div className="text-[8px] text-text-muted mb-1">Peers discovered + ARN-resolved via <strong className="text-[#0891b2]">AWS Agent Registry</strong> (semantic search)</div>
            {agent.a2aTargets.map((t, i) => {
              const target = AGENTS.find((a) => a.id === t.target);
              return (
                <div key={i} className="text-[9px] px-1.5 py-0.5 mb-0.5 rounded flex items-center gap-1" style={{ background: (target?.color || '#0891b2') + '10', color: target?.color || '#0891b2' }}>
                  <ArrowRight size={8} /> <strong>{target?.name || t.target}</strong> <span className="text-text-muted">— {t.reason}</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3 pt-2 border-t border-border flex items-center justify-center gap-1.5 text-[9px] font-mono text-text-muted flex-wrap">
          <span className="px-1.5 py-0.5 bg-status-warning-subtle text-status-warning-text rounded">Event</span>
          <ArrowRight size={8} />
          <span className="px-1.5 py-0.5 bg-surface-secondary rounded">EventBridge &rarr; SQS</span>
          <ArrowRight size={8} />
          <span className="px-1.5 py-0.5 rounded" style={{ background: agent.color + '15', color: agent.color }}>Agent reasons</span>
          <ArrowRight size={8} />
          <span className="px-1.5 py-0.5 bg-accent-subtle text-accent rounded">ask_human</span>
          <ArrowRight size={8} />
          <span className="px-1.5 py-0.5 bg-status-success-subtle text-status-success rounded">Human decides</span>
          <ArrowRight size={8} />
          <span className="px-1.5 py-0.5 rounded" style={{ background: agent.color + '15', color: agent.color }}>Resumes</span>
          {agent.writeActions.length > 0 && (<>
            <ArrowRight size={8} />
            <span className="px-1.5 py-0.5 rounded" style={{ background: '#7c3aed15', color: '#7c3aed' }}>Gateway write</span>
            <ArrowRight size={8} />
            <span className="px-1.5 py-0.5 bg-status-warning-subtle text-status-warning-text rounded">Event cascades</span>
          </>)}
          <ArrowRight size={8} />
          <span className="px-1.5 py-0.5 bg-status-success-subtle text-status-success rounded">Finding</span>
        </div>
      </div>
    );
  }

  if (selection.type === 'system') {
    const sys = SYSTEMS.find((s) => s.id === selection.id)!;
    const agents = AGENTS.filter((a) => sys.consumers.includes(a.id));
    return (
      <div className="bg-surface-primary border border-border rounded-xl p-4 shadow-lg animate-[fade-in_0.15s_ease-out]">
        <div className="flex items-start justify-between mb-2">
          <h3 className="text-[14px] font-bold">{sys.name} <span className="text-[10px] font-mono text-text-muted">{sys.table}</span></h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={14} /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <h4 className="text-[9px] font-bold uppercase mb-1">Events Produced</h4>
            {sys.events.map((e) => <div key={e} className="text-[9px] font-mono px-1.5 py-0.5 mb-0.5 bg-status-warning-subtle text-status-warning-text rounded">{e}</div>)}
          </div>
          <div>
            <h4 className="text-[9px] font-bold uppercase mb-1">Consumed By</h4>
            {agents.map((a) => <div key={a.id} className="text-[9px] px-1.5 py-0.5 mb-0.5 rounded" style={{ background: a.color + '15', color: a.color }}>{a.name}</div>)}
          </div>
        </div>
        <div className="mt-2 pt-2 border-t border-border text-[9px] font-mono text-text-muted text-center">
          DDB Stream &rarr; Lambda Producer &rarr; MSK topic &rarr; MSK Connect &rarr; EventBridge &rarr; Agent SQS
        </div>
      </div>
    );
  }

  if (selection.type === 'dashboard') {
    const dash = DASHBOARDS.find((d) => d.id === selection.id)!;
    const agents = AGENTS.filter((a) => dash.agents.includes(a.id));
    return (
      <div className="bg-surface-primary border border-border rounded-xl p-4 shadow-lg animate-[fade-in_0.15s_ease-out]">
        <div className="flex items-start justify-between mb-2">
          <h3 className="text-[14px] font-bold">{dash.name} Dashboard <span className="text-[10px] font-mono text-text-muted">channel: {dash.channel}</span></h3>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={14} /></button>
        </div>
        <h4 className="text-[9px] font-bold uppercase mb-1">Agent Feeds</h4>
        {agents.map((a) => (
          <div key={a.id} className="flex items-center gap-2 px-2 py-1 mb-1 rounded bg-surface-secondary">
            <Bot size={10} style={{ color: a.color }} />
            <span className="text-[10px] font-semibold" style={{ color: a.color }}>{a.name}</span>
            <span className="text-[8px] text-text-muted ml-auto">{a.domain}</span>
          </div>
        ))}
        <div className="text-[8px] text-text-muted mt-1">Panels: Event Feed &middot; Agent Activity &middot; HITL Pending Actions</div>
      </div>
    );
  }
  return null;
}

// ─── Main Page ──────────────────────────────────────────────────────

export function InteractiveArchPage() {
  const [selection, setSelection] = useState<Selection>(null);
  const hl = useHighlights(selection);

  const toggle = (type: Selection['type'], id: string) =>
    setSelection((prev) => prev?.id === id ? null : { type: type!, id });

  return (
    <div className="max-w-[1300px] mx-auto">
      <div className="flex items-center gap-3 mb-1">
        <Shield size={16} className="text-accent" />
        <h2 className="text-lg font-bold text-text-primary tracking-tight">Aerospace Digital Thread <span className="text-text-muted font-light">/ Interactive Architecture</span></h2>
      </div>
      <p className="text-[11px] text-text-tertiary mb-4">
        Click any element to explore connections. Agents prepare, humans decide.
      </p>

      <div className="grid grid-cols-[170px_1fr] gap-4">
        {/* ═══ LEFT: 10 Agents ═══ */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Bot size={12} className="text-accent" />
            <span className="text-[9px] font-bold text-text-muted uppercase tracking-wide">AgentCore Runtime</span>
          </div>
          <div className="flex flex-col gap-1">
            {AGENTS.map((a) => (
              <button key={a.id} onClick={() => toggle('agent', a.id)}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg border transition-all text-[10px] ${
                  selection?.id === a.id ? selected : hl.agents.has(a.id) ? highlighted : normal
                }`} style={{ borderLeftWidth: 3, borderLeftColor: a.color }}>
                <strong style={{ color: a.color }}>{a.name}</strong>
                <span className="text-[8px] text-text-muted block">{a.domain}</span>
              </button>
            ))}
          </div>
          <div className={`mt-1.5 px-2.5 py-1.5 rounded-lg border text-[9px] transition-all ${hl.registry ? highlighted : normal}`} style={{ borderLeftWidth: 3, borderLeftColor: '#0891b2' }}>
            <strong className="text-[#0891b2]">AWS Agent Registry</strong>
            <span className="text-[8px] text-text-muted block">Semantic discovery &middot; ARN resolve for A2A</span>
          </div>
          {/* AG-UI conversational agents — user-facing, browser-direct SSE (not event-triggered) */}
          <div className="mt-2.5 mb-1 flex items-center gap-1.5">
            <BarChart3 size={11} style={{ color: '#7c3aed' }} />
            <span className="text-[8px] font-bold text-text-muted uppercase tracking-wide">AG-UI · conversational</span>
          </div>
          <div className="flex flex-col gap-1">
            <div className="px-2.5 py-1.5 rounded-lg border bg-surface-primary text-[10px]" style={{ borderLeftWidth: 3, borderLeftColor: '#7c3aed' }}>
              <strong style={{ color: '#7c3aed' }}>Analytics Agent</strong>
              <span className="text-[8px] text-text-muted block">text-to-SQL &middot; Athena &rarr; chart/table/prose</span>
            </div>
            <div className="px-2.5 py-1.5 rounded-lg border bg-surface-primary text-[10px]" style={{ borderLeftWidth: 3, borderLeftColor: '#7c3aed' }}>
              <strong style={{ color: '#7c3aed' }}>Thread Navigator</strong>
              <span className="text-[8px] text-text-muted block">graph traverse + lake &rarr; highlight &middot; drawing &middot; widgets</span>
            </div>
          </div>
          <div className="text-[7px] text-text-muted text-center mt-1.5 font-mono">
            AGUI protocol &middot; browser-direct SSE &middot; Cognito &middot; read-only
          </div>
          <div className="text-[7px] text-text-muted text-center mt-2 font-mono">
            Strands SDK &middot; Claude Sonnet 4.6<br/>S3 sessions &middot; HITL suspend/resume
          </div>
        </div>

        {/* ═══ RIGHT: Enterprise Layers ═══ */}
        <div className="flex flex-col gap-1">

          {/* DASHBOARDS */}
          <LayerBox label="Dashboards — User Centric" color="#0891b2" >
            <div className="grid grid-cols-5 gap-2">
              {DASHBOARDS.map((d) => (
                <button key={d.id} onClick={() => toggle('dashboard', d.id)}
                  className={cls(selection?.id === d.id, hl.dashboards.has(d.id))}>
                  <Monitor size={12} className="mx-auto mb-0.5 text-text-muted" />
                  <strong className="text-[10px] block">{d.name}</strong>
                  <span className="text-[8px] text-text-muted">{d.agents.length} agents</span>
                </button>
              ))}
            </div>
            <div className="flex justify-center gap-2 mt-2 text-[8px] font-mono text-text-muted">
              <span>AppSync subscriptions</span> &middot; <span>IoT Core MQTT</span> &middot; <span>Cognito auth</span> &middot; <span>HITL panels</span>
            </div>
          </LayerBox>

          <FlowArrow label="AppSync &middot; WebSocket &middot; MQTT" active={hl.dataFlow} />

          {/* KNOWLEDGE GRAPH */}
          <LayerBox label="Knowledge Graph — Digital Thread" color="#059669" >
            <div className="flex justify-center gap-3 flex-wrap">
              <div className={`${nodeBase} ${hl.neptune ? highlighted : normal}`}>
                <strong className="text-[10px]" style={{ color: '#059669' }}>Neptune Serverless</strong>
                <span className="text-[8px] text-text-muted block">Single Source of Truth</span>
              </div>
              <div className={`${nodeBase} ${normal}`}><strong className="text-[9px]">Engineering View</strong><span className="text-[8px] text-text-muted block">parts &middot; BOMs</span></div>
              <div className={`${nodeBase} ${normal}`}><strong className="text-[9px]">Manufacturing View</strong><span className="text-[8px] text-text-muted block">WOs &middot; DHR</span></div>
              <div className={`${nodeBase} ${normal}`}><strong className="text-[9px]">Quality View</strong><span className="text-[8px] text-text-muted block">NCRs &middot; gaps</span></div>
              <div className={`${nodeBase} ${normal}`}><strong className="text-[9px]">Supply Chain View</strong><span className="text-[8px] text-text-muted block">suppliers &middot; lots</span></div>
            </div>
            <div className="flex justify-center gap-2 mt-2 text-[8px] font-mono text-text-muted">
              <span>Fast consumer &rarr; graph writer</span> &middot; <span>Slow consumer &rarr; Cert Readiness Agent</span>
            </div>
          </LayerBox>

          <FlowArrow label="MSK consumer &middot; Firehose" active={hl.dataFlow} />

          {/* DATA SERVICE LAYER */}
          <LayerBox label="Data Service Layer — Event Backbone + Analytics" color="#c2410c" >
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-wrap justify-center gap-2">
                <div className={`${nodeBase} ${hl.msk ? highlighted : normal}`}><strong className="text-[9px]" style={{ color: '#c2410c' }}>MSK Provisioned</strong><span className="text-[8px] text-text-muted block">11 topics &middot; Kafka 3.5.1</span></div>
                <div className={`${nodeBase} ${hl.msk ? highlighted : normal}`}><strong className="text-[8px]">ISA-95 Normalizer</strong><span className="text-[8px] text-text-muted block">ERP/PLM raw &rarr; ISA-95</span></div>
                <div className={`${nodeBase} ${hl.msk ? highlighted : normal}`}><strong className="text-[8px]">MSK Connect</strong><span className="text-[8px] text-text-muted block">EB Sink</span></div>
                <div className={`${nodeBase} ${hl.eventbridge ? highlighted : normal}`}><strong className="text-[9px]" style={{ color: '#c2410c' }}>EventBridge</strong><span className="text-[8px] text-text-muted block">aerospace-central</span></div>
                <div className={`${nodeBase} ${hl.gateway ? highlighted : normal}`}><strong className="text-[9px]" style={{ color: '#7c3aed' }}>AgentCore Gateway</strong><span className="text-[8px] text-text-muted block">MCP → REST API</span></div>
              </div>
              <div className="flex gap-2 mt-2">
                <div className={`flex-1 ${nodeBase} !text-left ${hl.dataFlow ? highlighted : normal}`}>
                  <strong className="text-[9px]" style={{ color: '#c2410c' }}>Kinesis Firehose</strong>
                  <span className="text-[8px] text-text-muted block">MSK consumer &rarr; DirectPut &rarr; S3</span>
                </div>
                <div className="flex-1 border border-border/60 bg-surface-primary rounded-lg p-2">
                  <span className="text-[8px] font-bold uppercase tracking-wide text-text-muted">Federated Data Catalog</span>
                  <div className="flex gap-1 mt-1">
                    <div className={`${nodeBase} !p-1.5 flex-1 ${hl.athena ? 'ring-2 ring-accent bg-accent-subtle border-accent/40' : 'border-border/40'}`}>
                      <strong className={`text-[9px] ${hl.athena ? 'text-accent' : 'text-text-secondary'}`}>Athena</strong>
                      <span className="text-[8px] text-text-muted block">SQL</span>
                    </div>
                    <div className={`${nodeBase} !p-1.5 flex-1 ${hl.athena ? 'ring-2 ring-accent bg-accent-subtle border-accent/40' : 'border-border/40'}`}>
                      <strong className={`text-[9px] ${hl.athena ? 'text-accent' : 'text-text-secondary'}`}>S3 Iceberg</strong>
                      <span className="text-[8px] text-text-muted block">parquet</span>
                    </div>
                    <div className={`${nodeBase} !p-1.5 flex-1 border-border/40`}>
                      <span className="text-[8px] text-text-muted">Glue</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </LayerBox>

          <FlowArrow label="DDB Stream &rarr; Lambda Producer &rarr; MSK" active={hl.dataFlow} />

          {/* SOURCE SYSTEMS */}
          <LayerBox label="System of Records — 10 Source Systems" color="#1e3a5f" >
            <div className="grid grid-cols-5 gap-2">
              {SYSTEMS.map((s) => (
                <button key={s.id} onClick={() => toggle('system', s.id)}
                  className={cls(selection?.id === s.id, hl.systems.has(s.id))}>
                  <strong className="text-[10px] block">{s.name}</strong>
                  <span className="text-[8px] text-text-muted font-mono">{s.table}</span>
                </button>
              ))}
            </div>
            <div className="flex justify-center mt-2 text-[8px] font-mono text-text-muted">
              ECS Generator Service — 9 generators + SCADA MQTT loop &middot; demo-control
            </div>
          </LayerBox>

          {/* DETAIL PANEL */}
          <div className="mt-1">
            <DetailPanel selection={selection} onClose={() => setSelection(null)} />
            {!selection && (
              <div className="bg-surface-secondary rounded-xl p-3 text-center">
                <p className="text-[11px] text-text-muted">Click any <strong>agent</strong>, <strong>source system</strong>, or <strong>dashboard</strong> to explore data flows and HITL interactions</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Infrastructure bar */}
      <div className="mt-3 bg-[#1e3a5f] text-white text-center py-2 rounded-lg text-[9px] font-medium tracking-wide">
        Secured and robust infrastructure — <span className="opacity-70">Sovereign by design</span> — AWS CDK &middot; 12 stacks &middot; eu-west-1
      </div>

      <div className="flex justify-center gap-1.5 flex-wrap mt-3">
        {['AWS CDK', '15 stacks', 'eu-west-1', 'Docker ARM64', 'Strands Agents', 'AgentCore', 'MSK', 'Neptune', 'Iceberg', 'IoT Core', 'AppSync', 'Bedrock Claude'].map((t) => (
          <span key={t} className="text-[7px] font-mono px-2 py-0.5 rounded-full bg-surface-secondary border border-border text-text-muted">{t}</span>
        ))}
      </div>
    </div>
  );
}
