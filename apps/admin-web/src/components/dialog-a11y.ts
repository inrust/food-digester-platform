import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Shared modal behavior: safe initial focus, focus trap, Escape, focus restore and inert background. */
export function useDialogA11y(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  overlayRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    const overlay = overlayRef.current;
    const background = [...document.body.children].filter((node) => node !== overlay);
    const snapshots = background.map((node) => ({
      node: node as HTMLElement,
      inert: (node as HTMLElement).inert,
      ariaHidden: node.getAttribute('aria-hidden'),
    }));
    for (const node of background) {
      (node as HTMLElement).inert = true;
      node.ariaHidden = 'true';
    }

    const focusable = () => [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const initial = initialFocusRef?.current ?? focusable()[0] ?? dialogRef.current;
    initial?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = focusable();
      if (nodes.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      for (const snapshot of snapshots) {
        snapshot.node.inert = snapshot.inert;
        snapshot.node.ariaHidden = snapshot.ariaHidden;
      }
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, [dialogRef, initialFocusRef, open, overlayRef]);
}
