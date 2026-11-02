// Tiny i18n: no dependencies, no build. English is the default and the fallback.
// Language: ?lang=xx (remembered) > localStorage "pad.lang" > browser language > "en".
// Each page registers its own dictionaries; this file only holds the strings shared by all pages.

export const LANGS = { en: "English", it: "Italiano" };

function detect() {
  const fromUrl = new URLSearchParams(location.search).get("lang");
  if (fromUrl && Object.hasOwn(LANGS, fromUrl)) localStorage.setItem("pad.lang", fromUrl);
  for (const c of [localStorage.getItem("pad.lang"), navigator.language?.slice(0, 2)]) {
    if (c && Object.hasOwn(LANGS, c)) return c;
  }
  return "en";
}

export const lang = detect();
const dicts = {
  en: { "tile.hold": "Long press", "tile.button": "button" },
  it: { "tile.hold": "Pressione lunga", "tile.button": "pulsante" },
};

// register({ en: {...}, it: {...} }) merges a page's strings into the shared dictionaries.
export function register(parts) {
  for (const l of Object.keys(LANGS)) Object.assign(dicts[l], parts[l]);
}

// t("key", { n: 3 }) replaces {n}. A missing key falls back to English, then to the key itself.
export function t(key, vars) {
  const s = dicts[lang][key] ?? dicts.en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? "")) : s;
}

export function setLang(l) {
  localStorage.setItem("pad.lang", l);
  const url = new URL(location.href);
  url.searchParams.delete("lang");
  location.replace(url);
}

// Static HTML: data-i18n (text), data-i18n-title, data-i18n-aria (aria-label), data-i18n-ph (placeholder).
export function applyStatic(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll("[data-i18n-aria]")) el.setAttribute("aria-label", t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll("[data-i18n-ph]")) el.placeholder = t(el.dataset.i18nPh);
}
