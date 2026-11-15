// Accessibility toggles shared by every page: light / dark theme and a bold-text mode.
// The choice is remembered per browser (localStorage) and applied as attributes on <html>:
//   data-theme="light" | "dark"     data-bold="1"
// Each page also has a tiny inline script in <head> that applies the saved choice before the
// page paints, so there's no flash of the wrong theme.

const THEME_KEY = "physio.theme";
const BOLD_KEY = "physio.bold";
const root = document.documentElement;

const read = (k) => {
  try { return localStorage.getItem(k); } catch { return null; }
};
const write = (k, v) => {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode: still works for this page */ }
};

function currentTheme() {
  return root.dataset.theme || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
}

function apply(theme, bold) {
  root.dataset.theme = theme;
  if (bold) root.dataset.bold = "1";
  else delete root.dataset.bold;
  // Charts and canvases read CSS variables when they draw; nudge them to redraw.
  window.dispatchEvent(new Event("resize"));
  window.dispatchEvent(new CustomEvent("a11ychange", { detail: { theme, bold } }));
}

function makeButtons() {
  const wrap = document.createElement("span");
  wrap.className = "a11y-toggles";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Display settings");

  const themeBtn = document.createElement("button");
  themeBtn.type = "button";
  const boldBtn = document.createElement("button");
  boldBtn.type = "button";

  const sync = () => {
    const light = currentTheme() === "light";
    themeBtn.textContent = light ? "🌙 Dark mode" : "☀️ Light mode";
    themeBtn.title = light ? "Switch to dark mode" : "Switch to light mode";
    themeBtn.setAttribute("aria-label", themeBtn.title);
    const bold = root.dataset.bold === "1";
    boldBtn.innerHTML = `<b>B</b> Bold text`;
    boldBtn.title = bold ? "Turn bold text off" : "Make text bigger and bolder";
    boldBtn.setAttribute("aria-pressed", String(bold));
  };

  themeBtn.addEventListener("click", () => {
    const next = currentTheme() === "light" ? "dark" : "light";
    write(THEME_KEY, next);
    apply(next, root.dataset.bold === "1");
    sync();
  });
  boldBtn.addEventListener("click", () => {
    const next = root.dataset.bold !== "1";
    write(BOLD_KEY, next ? "1" : null);
    apply(currentTheme(), next);
    sync();
  });

  sync();
  wrap.append(themeBtn, boldBtn);
  return wrap;
}

// Put the toggles in the page header's controls; pages without a header (login) get a floating bar.
const host = document.querySelector("header .controls");
const buttons = makeButtons();
if (host) {
  const logout = host.querySelector("#logout");
  host.insertBefore(buttons, logout ?? null);
} else {
  buttons.classList.add("a11y-floating");
  document.body.appendChild(buttons);
}
