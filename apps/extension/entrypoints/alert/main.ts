import { browser } from 'wxt/browser';

// The bubble under the toolbar icon (background.ts `alert`): what came while no panel was open, and a way in.
const CLOSE_MS = 10_000;

const list = document.getElementById('list')!;
const alerts = ((await browser.storage.session.get('mirattic.alerts'))['mirattic.alerts'] ?? []) as { title: string; body: string }[];
for (const a of alerts) {
  const li = document.createElement('li');
  const b = document.createElement('b');
  b.textContent = a.title;
  li.append(b);
  if (a.body) {
    const span = document.createElement('span');
    span.textContent = a.body;
    li.append(span);
  }
  list.append(li);
}

// Known before the click: sidePanel.open must run inside the click's user gesture.
const { id: windowId } = await browser.windows.getCurrent();
document.getElementById('open')!.addEventListener('click', () => {
  if (windowId !== undefined) void browser.sidePanel.open({ windowId });
  window.close();
});

// Closes by itself unless the pointer is on it.
let timer = setTimeout(() => window.close(), CLOSE_MS);
document.body.addEventListener('mouseenter', () => clearTimeout(timer));
document.body.addEventListener('mouseleave', () => (timer = setTimeout(() => window.close(), CLOSE_MS)));
