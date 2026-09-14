type CompletenessGaugeProps = {
  score: number; // 0-100
  label?: string;
};

export function CompletenessGauge({ score, label = 'Completeness' }: CompletenessGaugeProps) {
  const color = score >= 80 ? 'text-status-success' : score >= 50 ? 'text-status-warning' : 'text-status-error';
  const bgColor = score >= 80 ? 'bg-status-success' : score >= 50 ? 'bg-status-warning' : 'bg-status-error';

  return (
    <div className="text-center">
      <div className="relative inline-flex items-center justify-center w-24 h-24">
        {/* Background ring */}
        <svg className="absolute w-full h-full -rotate-90" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="42" fill="none" stroke="var(--color-border)" strokeWidth="8" />
          <circle
            cx="50" cy="50" r="42" fill="none"
            stroke="currentColor"
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={`${score * 2.64} ${264 - score * 2.64}`}
            className={color}
          />
        </svg>
        <span className={`text-2xl font-bold font-mono ${color}`}>{score}</span>
      </div>
      <p className="text-[10px] font-mono text-text-muted mt-1 uppercase">{label}</p>
    </div>
  );
}
