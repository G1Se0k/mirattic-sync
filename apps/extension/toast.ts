import { browser } from 'wxt/browser';

// Over a fullscreen video only (plan.md decision 87): the toolbar bubble can't show there. The background
// sends every alert to the provider tabs; a page not in fullscreen ignores it. Text only, in a shadow root so
// the page's styles don't reach it; it reads nothing from the page but whether it is fullscreen.

export const TOAST = 'mirattic:toast';
export type ToastMessage = { type: typeof TOAST; title: string; body: string };

const SHOWN_MS = 8_000;

export function serveToast() {
  let current: HTMLElement | null = null;
  const remove = () => {
    current?.remove();
    current = null;
  };
  document.addEventListener('fullscreenchange', () => !document.fullscreenElement && remove());

  browser.runtime.onMessage.addListener((m: ToastMessage, sender) => {
    if (sender.id !== browser.runtime.id || m?.type !== TOAST) return;
    const host = document.fullscreenElement;
    // A fullscreen <video> (or frame) renders no children: nothing can show over it (known limit).
    if (!host || ['VIDEO', 'IFRAME', 'CANVAS', 'IMG'].includes(host.tagName)) return;
    remove();
    const el = document.createElement('div');
    const root = el.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      div { position: fixed; top: 24px; right: 24px; z-index: 2147483647; max-width: 360px; padding: 12px 16px;
        border-radius: 10px; background: rgba(28, 28, 30, .88); color: #ececea; font: 14px/1.45 system-ui, sans-serif;
        box-shadow: 0 6px 24px rgba(0, 0, 0, .35); cursor: pointer; }
      b { display: block; font-weight: 600; }
      span { color: #b8b8b5; overflow-wrap: anywhere; }
    </style><div role="status"><b></b><span></span></div>`;
    root.querySelector('b')!.textContent = m.title;
    root.querySelector('span')!.textContent = m.body;
    root.querySelector('div')!.addEventListener('click', remove);
    host.append(el);
    current = el;
    setTimeout(() => current === el && remove(), SHOWN_MS);
  });
}
