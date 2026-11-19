import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE = 'a[href],button,input,select,textarea,summary:first-of-type,[tabindex]';

interface DialogLayer {
  readonly overlay: HTMLElement;
  readonly dialog: HTMLElement;
  previousFocus: Element | null;
}

const layers: DialogLayer[] = [];
const background = new Map<HTMLElement, { inert: boolean; ariaHidden: string | null }>();

function tabbableElements(dialog: HTMLElement): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((node) => {
    if (
      node.tabIndex < 0 ||
      node.matches(':disabled, input[type="hidden"]') ||
      node.closest('[hidden], [inert], [aria-hidden="true"]') !== null
    )
      return false;
    const closedDetails = node.closest('details:not([open])');
    return closedDetails === null || closedDetails.querySelector(':scope > summary')?.contains(node) === true;
  });
}

function syncBackground(focus: (top: DialogLayer | undefined) => void) {
  const top = layers.at(-1);
  for (const [node, snapshot] of background) {
    if (top !== undefined && node !== top.overlay && node.isConnected) continue;
    node.inert = snapshot.inert;
    node.ariaHidden = snapshot.ariaHidden;
    background.delete(node);
  }

  // React may still have focus in the previous layer, so move it before hiding that layer.
  focus(top);
  if (top === undefined) return;
  for (const node of document.body.children) {
    if (!(node instanceof HTMLElement) || node === top.overlay || background.has(node)) continue;
    background.set(node, { inert: node.inert, ariaHidden: node.getAttribute('aria-hidden') });
    node.inert = true;
    node.ariaHidden = 'true';
  }
}

/** Shared modal behavior. Only the topmost portal owns keyboard input and focus. */
export function useDialogA11y(
  open: boolean,
  dialogRef: RefObject<HTMLElement | null>,
  overlayRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: RefObject<HTMLElement | null>,
  fallbackFocusRef?: RefObject<HTMLElement | null>,
) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    const overlay = overlayRef.current;
    if (!open || dialog === null || overlay === null) return;
    const layer = { dialog, overlay, previousFocus: document.activeElement };
    layers.push(layer);
    syncBackground(() => {
      (initialFocusRef?.current ?? tabbableElements(dialog)[0] ?? dialog).focus({ preventScroll: true });
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (layers.at(-1) !== layer || event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = tabbableElements(dialog);
      const first = nodes[0];
      const last = nodes.at(-1);
      const active = document.activeElement;
      if (!nodes.includes(active as HTMLElement) || active === (event.shiftKey ? first : last)) {
        event.preventDefault();
        ((event.shiftKey ? last : first) ?? dialog).focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const wasTop = layers.at(-1) === layer;
      layers.splice(layers.indexOf(layer), 1);
      for (const remaining of layers) {
        if (overlay.contains(remaining.previousFocus)) remaining.previousFocus = layer.previousFocus;
      }
      syncBackground((top) => {
        if (!wasTop) return;
        const previous = layer.previousFocus;
        if (
          previous instanceof HTMLElement &&
          previous.isConnected &&
          (top === undefined || top.overlay.contains(previous))
        ) {
          previous.focus({ preventScroll: true });
        }
        if (top === undefined && document.activeElement === document.body) {
          fallbackFocusRef?.current?.focus({ preventScroll: true });
        }
        if (top !== undefined && !top.dialog.contains(document.activeElement)) {
          (tabbableElements(top.dialog)[0] ?? top.dialog).focus({ preventScroll: true });
        }
      });
    };
  }, [dialogRef, fallbackFocusRef, initialFocusRef, open, overlayRef]);
}
