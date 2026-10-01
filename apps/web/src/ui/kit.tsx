import { useEffect, useState, type DragEvent, type ReactNode } from "react";
import type { Format } from "@ygosim/protocol";
import { getBanlist, listFormats, thumbUrl } from "../api";

export type Limit = 0 | 1 | 2;
const LIMIT_LABEL = ["Forbidden", "Limited", "Semi-Limited"] as const;

/** Small card image with optional banlist and copy-count badges. */
export function CardThumb({ code, limit, count, className = "", title, onClick, onContextMenu, onMouseEnter, draggable, onDragStart }: {
  code: number; limit?: Limit; count?: number; className?: string; title?: string;
  onClick?: (e: React.MouseEvent) => void; onContextMenu?: (e: React.MouseEvent) => void; onMouseEnter?: () => void;
  draggable?: boolean; onDragStart?: (e: DragEvent) => void;
}) {
  return (
    <button className={`dcard ${className}`} title={title} onClick={onClick} onMouseEnter={onMouseEnter} draggable={draggable} onDragStart={onDragStart}
      onContextMenu={(e) => { if (onContextMenu) { e.preventDefault(); onContextMenu(e); } }}>
      <img src={thumbUrl(code)} alt="" loading="lazy" draggable={false} />
      {limit !== undefined && <i className={`ban ban-${limit}`} title={LIMIT_LABEL[limit]}>{limit === 0 ? "✕" : limit}</i>}
      {!!count && <span className="count-badge">{count}</span>}
    </button>
  );
}

export function Modal({ title, subtitle, children, footer, onClose, width }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode; onClose: () => void; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined} role="dialog" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function useFormats() {
  const [formats, setFormats] = useState<Format[]>([]);
  useEffect(() => { listFormats().then(setFormats); }, []);
  return formats;
}

export function useBanlist(format: string) {
  const [ban, setBan] = useState<Record<number, Limit>>({});
  useEffect(() => { let alive = true; getBanlist(format).then((b) => alive && setBan(b)); return () => { alive = false; }; }, [format]);
  return ban;
}

/** Copy text and briefly report it. */
export function useCopy(): [string | null, (text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  return [copied, (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(text);
    setTimeout(() => setCopied((c) => (c === text ? null : c)), 1400);
  }];
}
