import React, { useEffect } from 'react';
import type { Severity } from '../types';
import { useConfigStore } from '../store/useConfigStore';

export function StatusDot({ sev, pulse }: { sev: Severity; pulse?: boolean }) {
  const enabled = useConfigStore((s) => s.prefs.pulseAnimations);
  return <span className={`dot ${sev} ${pulse && enabled ? 'pulse' : ''}`} aria-hidden />;
}

export function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: React.ReactNode;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__header">
          <h3 className="modal__title">{title}</h3>
          <button className="btn-ghost btn-icon" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  );
}

export function Confirm({ message, onConfirm, onCancel, confirmLabel = 'Confirmer' }: {
  message: string; onConfirm: () => void; onCancel: () => void; confirmLabel?: string;
}) {
  return (
    <Modal title="Confirmation" onClose={onCancel}>
      <p style={{ marginTop: 0 }}>{message}</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button onClick={onCancel}>Annuler</button>
        <button className="btn-danger" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}
