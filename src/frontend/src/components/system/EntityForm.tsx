import { useState } from 'react';
import { X } from 'lucide-react';
import type { FieldConfig } from './EntityTable';

type EntityFormProps = {
  fields: FieldConfig[];
  defaults: Record<string, any>;
  onSubmit: (data: Record<string, any>) => void;
  onCancel: () => void;
};

export function EntityForm({ fields, defaults, onSubmit, onCancel }: EntityFormProps) {
  const editableFields = fields.filter((f) => !f.readOnly);
  const [values, setValues] = useState<Record<string, any>>({ ...defaults });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(values);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Modal */}
      <form
        onSubmit={handleSubmit}
        className="relative bg-surface-primary border border-border rounded-xl shadow-2xl
          w-full max-w-md mx-4 overflow-hidden"
        style={{ animation: 'slide-up 0.2s ease-out' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <h2 className="text-sm font-bold text-text-primary uppercase tracking-wide">
            New Non-Conformance
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Fields */}
        <div className="px-5 py-4 space-y-3">
          {editableFields.map((f) => (
            <div key={f.key}>
              <label className="block text-[10px] font-mono font-semibold text-text-muted
                uppercase tracking-[0.1em] mb-1">
                {f.label}
              </label>
              <input
                type="text"
                value={values[f.key] ?? ''}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [f.key]: e.target.value }))
                }
                className="w-full bg-surface-primary border border-border-strong rounded-lg px-3 py-2
                  text-[13px] font-mono text-text-primary placeholder-text-muted
                  focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent
                  transition-colors"
                placeholder={f.label}
              />
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 px-5 py-3.5 border-t border-border bg-surface-secondary">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 text-[12px] font-medium text-text-secondary bg-surface-tertiary
              border border-border rounded-lg hover:bg-border/40 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-1.5 text-[12px] font-bold text-white bg-accent
              rounded-lg hover:bg-accent-hover transition-colors uppercase tracking-wide"
          >
            Create NCR
          </button>
        </div>
      </form>
    </div>
  );
}
