// Small dependency-free SVG charts for the physio dashboard.
//   lineChart(el, { points: [{ x: Date, y: number }], fmt, label })
//   barChart(el,  { values: number[], labels: string[], fmt, label })
//   stackedBars(el, { series: [{ name, color, values }], labels, fmt })
// All charts: thin marks, recessive grid, hover tooltip, text in text colours (never series colour).

const CSS = getComputedStyle(document.documentElement);
const col = (name, fallback) => CSS.getPropertyValue(name).trim() || fallback;
const INK = { text: col("--text", "#e8ecf3"), muted: col("--muted", "#8f9bb0"), grid: col("--line", "#2a3140") };
// Validated against the panel surface (#171c25): blue / orange / aqua, dark-mode steps.
export const SERIES = { blue: "#3987e5", orange: "#d95926", aqua: "#199e70" };

const svgEl = (tag, attrs = {}, parent) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent?.appendChild(el);
  return el;
};
const niceMax = (v) => {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => n <= x) ?? 10;
  return step * p;
};
const fmtDate = (d) => d.toLocaleDateString([], { day: "numeric", month: "short" });

function frame(el, { height = 180, padL = 44, padR = 12, padT = 10, padB = 26 } = {}) {
  el.innerHTML = "";
  const width = Math.max(240, el.clientWidth || 480);
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width: "100%", height, class: "chart-svg" }, el);
  const tip = document.createElement("div");
  tip.className = "chart-tip";
  tip.hidden = true;
  el.appendChild(tip);
  const showTip = (html, x, y) => {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    tip.style.left = `${Math.max(4, Math.min(x, r.width - tip.offsetWidth - 8))}px`;
    tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
  };
  const hideTip = () => (tip.hidden = true);
  return { svg, width, height, padL, padR, padT, padB, plotW: width - padL - padR, plotH: height - padT - padB, showTip, hideTip };
}

function yAxis(f, yMax, fmt, ticks = 4) {
  for (let i = 0; i <= ticks; i++) {
    const v = (yMax / ticks) * i;
    const y = f.padT + f.plotH - (v / yMax) * f.plotH;
    svgEl("line", { x1: f.padL, x2: f.width - f.padR, y1: y, y2: y, stroke: INK.grid, "stroke-width": 1 }, f.svg);
    const t = svgEl("text", { x: f.padL - 6, y: y + 4, "text-anchor": "end", fill: INK.muted, "font-size": 11 }, f.svg);
    t.textContent = fmt(v);
  }
}

export function empty(el, msg = "No data yet") {
  el.innerHTML = `<div class="chart-empty">${msg}</div>`;
}

/** Single-series line over time with a crosshair tooltip. */
export function lineChart(el, { points, fmt = (v) => v, color = SERIES.blue, label = "" }) {
  if (!points?.length) return empty(el);
  const f = frame(el);
  const xs = points.map((p) => +p.x);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const yMax = niceMax(Math.max(...points.map((p) => p.y)) * 1.1);
  const X = (x) => f.padL + (x1 === x0 ? f.plotW / 2 : ((x - x0) / (x1 - x0)) * f.plotW);
  const Y = (y) => f.padT + f.plotH - (y / yMax) * f.plotH;
  yAxis(f, yMax, fmt);

  // x labels: first, last, and a few in between
  const n = points.length;
  const step = Math.max(1, Math.ceil(n / 6));
  points.forEach((p, i) => {
    if (i % step && i !== n - 1) return;
    const t = svgEl("text", { x: X(+p.x), y: f.height - 8, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle", fill: INK.muted, "font-size": 11 }, f.svg);
    t.textContent = fmtDate(p.x);
  });

  const d = points.map((p, i) => `${i ? "L" : "M"}${X(+p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
  svgEl("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round" }, f.svg);
  for (const p of points) svgEl("circle", { cx: X(+p.x), cy: Y(p.y), r: 4, fill: color, stroke: "#171c25", "stroke-width": 2 }, f.svg);

  // last value direct label
  const last = points[n - 1];
  const lt = svgEl("text", { x: X(+last.x) - 6, y: Y(last.y) - 8, "text-anchor": "end", fill: INK.text, "font-size": 11, "font-weight": 600 }, f.svg);
  lt.textContent = fmt(last.y);

  // crosshair
  const cross = svgEl("line", { y1: f.padT, y2: f.padT + f.plotH, stroke: INK.muted, "stroke-width": 1, "stroke-dasharray": "3 3", visibility: "hidden" }, f.svg);
  const hit = svgEl("rect", { x: f.padL, y: f.padT, width: f.plotW, height: f.plotH, fill: "transparent" }, f.svg);
  hit.addEventListener("mousemove", (e) => {
    const r = f.svg.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * f.width;
    let best = points[0], bd = Infinity;
    for (const p of points) {
      const d = Math.abs(X(+p.x) - mx);
      if (d < bd) (bd = d), (best = p);
    }
    cross.setAttribute("x1", X(+best.x));
    cross.setAttribute("x2", X(+best.x));
    cross.setAttribute("visibility", "visible");
    f.showTip(`<b>${fmtDate(best.x)}</b><br>${label ? label + ": " : ""}${fmt(best.y)}${best.extra ? `<br><span class="muted">${best.extra}</span>` : ""}`, (X(+best.x) / f.width) * r.width, (Y(best.y) / f.height) * r.height);
  });
  hit.addEventListener("mouseleave", () => {
    cross.setAttribute("visibility", "hidden");
    f.hideTip();
  });
}

/** Bars for one measure per category (e.g. ROM per rep). */
export function barChart(el, { values, labels, fmt = (v) => v, color = SERIES.blue, refLine = null }) {
  if (!values?.length) return empty(el);
  const f = frame(el, { height: 160 });
  const yMax = niceMax(Math.max(...values, refLine ?? 0) * 1.1);
  const Y = (y) => f.padT + f.plotH - (y / yMax) * f.plotH;
  yAxis(f, yMax, fmt);
  const n = values.length;
  const slot = f.plotW / n;
  const bw = Math.max(4, Math.min(28, slot - 4));
  values.forEach((v, i) => {
    const x = f.padL + slot * i + (slot - bw) / 2;
    const r = svgEl("rect", { x, y: Y(v), width: bw, height: Math.max(0, f.padT + f.plotH - Y(v)), rx: 3, fill: color }, f.svg);
    r.addEventListener("mouseenter", (e) => {
      const rr = f.svg.getBoundingClientRect();
      f.showTip(`<b>${labels[i]}</b><br>${fmt(v)}`, ((x + bw / 2) / f.width) * rr.width, (Y(v) / f.height) * rr.height);
    });
    r.addEventListener("mouseleave", f.hideTip);
    if (n <= 15 || i % Math.ceil(n / 15) === 0) {
      const t = svgEl("text", { x: x + bw / 2, y: f.height - 8, "text-anchor": "middle", fill: INK.muted, "font-size": 11 }, f.svg);
      t.textContent = labels[i];
    }
  });
  if (refLine != null) {
    svgEl("line", { x1: f.padL, x2: f.width - f.padR, y1: Y(refLine), y2: Y(refLine), stroke: INK.text, "stroke-width": 1, "stroke-dasharray": "4 4", opacity: 0.6 }, f.svg);
    const t = svgEl("text", { x: f.width - f.padR, y: Y(refLine) - 4, "text-anchor": "end", fill: INK.muted, "font-size": 10 }, f.svg);
    t.textContent = "target";
  }
}

/** Stacked bars: several phases per category (e.g. concentric / hold / eccentric per rep). Legend included. */
export function stackedBars(el, { series, labels, fmt = (v) => v }) {
  if (!series?.length || !labels?.length) return empty(el);
  const f = frame(el, { height: 180, padT: 26 });
  const n = labels.length;
  const totals = labels.map((_, i) => series.reduce((s, sr) => s + (sr.values[i] || 0), 0));
  const yMax = niceMax(Math.max(...totals) * 1.1);
  const Y = (y) => f.padT + f.plotH - (y / yMax) * f.plotH;
  yAxis(f, yMax, fmt);
  const slot = f.plotW / n;
  const bw = Math.max(4, Math.min(28, slot - 4));
  // legend (top-left)
  let lx = f.padL;
  for (const sr of series) {
    svgEl("rect", { x: lx, y: 6, width: 10, height: 10, rx: 2, fill: sr.color }, f.svg);
    const t = svgEl("text", { x: lx + 14, y: 15, fill: INK.muted, "font-size": 11 }, f.svg);
    t.textContent = sr.name;
    lx += 14 + sr.name.length * 6.5 + 14;
  }
  labels.forEach((lab, i) => {
    let acc = 0;
    const x = f.padL + slot * i + (slot - bw) / 2;
    series.forEach((sr, si) => {
      const v = sr.values[i] || 0;
      if (!v) return;
      const y0 = Y(acc + v), y1 = Y(acc);
      const r = svgEl("rect", { x, y: y0 + (si ? 1 : 0), width: bw, height: Math.max(0, y1 - y0 - (si ? 1 : 0)), rx: si === series.length - 1 ? 3 : 0, fill: sr.color }, f.svg);
      r.addEventListener("mouseenter", () => {
        const rr = f.svg.getBoundingClientRect();
        f.showTip(`<b>${lab}</b><br>${series.map((s) => `${s.name}: ${fmt(s.values[i] || 0)}`).join("<br>")}<br><span class="muted">total ${fmt(totals[i])}</span>`, ((x + bw / 2) / f.width) * rr.width, (y0 / f.height) * rr.height);
      });
      r.addEventListener("mouseleave", f.hideTip);
      acc += v;
    });
    if (n <= 15 || i % Math.ceil(n / 15) === 0) {
      const t = svgEl("text", { x: x + bw / 2, y: f.height - 8, "text-anchor": "middle", fill: INK.muted, "font-size": 11 }, f.svg);
      t.textContent = lab;
    }
  });
}
