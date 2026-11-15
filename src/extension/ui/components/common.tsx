import type { ButtonHTMLAttributes, ComponentChildren, TextareaHTMLAttributes, VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Tone } from '../../../shared/statusText.js';

export function Dot({ tone }: { tone: Tone | 'act' }): VNode {
  return <span class={`dot dot--${tone === 'act' ? 'bad' : tone}`} aria-hidden="true" />;
}

export function Tag({ tone, children }: { tone: Tone | 'act'; children: ComponentChildren }): VNode {
  return <span class={`tag tag--${tone}`}>{children}</span>;
}

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'size' | 'type' | 'disabled'> {
  variant?: 'default' | 'primary' | 'danger' | 'quiet';
  small?: boolean;
  busy?: boolean;
  /** Shown instead of the label while the action runs. */
  busyLabel?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
}

export function Button({ variant = 'default', small, busy, busyLabel, disabled, type = 'button', children, class: extra, ...rest }: ButtonProps): VNode {
  const classes = ['btn', variant !== 'default' ? `btn--${variant}` : '', small ? 'btn--small' : '', typeof extra === 'string' ? extra : ''].filter(Boolean).join(' ');
  return (
    <button {...rest} type={type} class={classes} disabled={disabled || busy} aria-busy={busy ? 'true' : undefined}>
      {busy && busyLabel ? busyLabel : children}
    </button>
  );
}

/** A destructive action that asks once more in place, instead of opening a blocking dialog. */
export function ConfirmButton({ label, confirmLabel, onConfirm, busy, small }: { label: string; confirmLabel: string; onConfirm: () => void; busy?: boolean; small?: boolean }): VNode {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = window.setTimeout(() => setArmed(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <Button
      variant="danger"
      small={small}
      busy={busy}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : label}
    </Button>
  );
}

export function PaneHeader({ title, meta, children }: { title: string; meta?: ComponentChildren; children?: ComponentChildren }): VNode {
  return (
    <header class="pane__head">
      <h2 class="label pane__title">{title}</h2>
      {meta !== undefined && <span class="pane__meta">{meta}</span>}
      {children && <div class="pane__actions">{children}</div>}
    </header>
  );
}

export function Empty({ title, children }: { title: string; children?: ComponentChildren }): VNode {
  return (
    <div class="empty">
      <p class="empty__title">{title}</p>
      {children && <p class="empty__body">{children}</p>}
    </div>
  );
}

/** A textarea that grows with its content up to a limit. */
export function AutoTextarea(props: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'> & { value: string; maxRows?: number }): VNode {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { maxRows = 10, ...rest } = props;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight + 2, line * maxRows + 16)}px`;
  }, [props.value, maxRows]);
  return <textarea ref={ref} {...rest} />;
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }): VNode {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  useEffect(() => {
    if (state === 'idle') return undefined;
    const timer = window.setTimeout(() => setState('idle'), 2_000);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <Button
      small
      variant="quiet"
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => setState('copied'),
          () => setState('failed'),
        );
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label}
    </Button>
  );
}
