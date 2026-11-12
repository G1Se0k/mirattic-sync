// The site pages' language (plan.md decision 124): ?lang= (kept for the next page), else the one picked before, else
// the browser's (Korean, Japanese, English for any other). The page's Korean stays the key: each text, and each
// alt / aria-label / content / title, found whole in the page's <script id="page-text"> {"en": {...}, "ja": {...}},
// is replaced; a block marked data-lang shows only in its language. Loaded at the end of <body>.
(() => {
  const LANGS = ['ko', 'en', 'ja'];
  const asked = new URLSearchParams(location.search).get('lang');
  let picked = null;
  try {
    if (LANGS.includes(asked)) localStorage.setItem('mirattic.lang', asked);
    picked = localStorage.getItem('mirattic.lang');
  } catch (e) {
    // no storage: this page only
  }
  const browser = String(navigator.language || '').slice(0, 2).toLowerCase();
  const lang = LANGS.includes(asked) ? asked : LANGS.includes(picked) ? picked : browser === 'ko' || browser === 'ja' ? browser : 'en';
  const source = document.getElementById('page-text');
  const words = (lang !== 'ko' && source && JSON.parse(source.textContent)[lang]) || {};
  const key = (s) => s.trim().replace(/\s+/g, ' ');
  const fill = (s, params) => (params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s);

  /** `ko` in the page's language, its `{name}`s filled. */
  window.t = (ko, params) => fill(words[ko] ?? ko, params);
  window.pageLang = lang;

  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-lang]')) el.hidden = el.dataset.lang !== lang;
  if (lang !== 'ko') {
    const walk = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.parentElement.closest('script, style')) continue;
      const k = key(n.nodeValue);
      if (k && k in words) n.nodeValue = n.nodeValue.match(/^\s*/)[0] + words[k] + n.nodeValue.match(/\s*$/)[0];
    }
    for (const el of document.querySelectorAll('[alt], [aria-label], meta[content], [title]')) {
      for (const a of ['alt', 'aria-label', 'content', 'title']) {
        const v = el.getAttribute(a);
        if (v && key(v) in words) el.setAttribute(a, words[key(v)]);
      }
    }
  }
  // Language links: the one shown marked.
  for (const a of document.querySelectorAll('a[data-set-lang]')) {
    a.href = `?lang=${a.dataset.setLang}`;
    if (a.dataset.setLang === lang) a.setAttribute('aria-current', 'true');
  }
})();
