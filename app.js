/* =====================================================================
   Johor Site Guide — app logic (vanilla JS, no build step, no libraries)
   Reads window.SITES (data/sites.js) and window.I18N (data/i18n.js).
   URL parameters (used by QR codes):
     ?site=main             open a site (site id from data/sites.js)
     &here=main_gate        mark "You are here" + set as route start
     &to=canteen            pre-select destination and show the route
     &lang=ms               force language (en | ms | zh)
   ===================================================================== */
(() => {
  "use strict";

  const SITES = window.SITES || [];
  const I18N = window.I18N || {};
  const $ = (id) => document.getElementById(id);
  const svgNS = "http://www.w3.org/2000/svg";
  const WALK_SPEED = 1.2; // metres per second

  /* ---------- persistent prefs (safe if storage is blocked) ---------- */
  const store = {
    get(k) { try { return localStorage.getItem("sg_" + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem("sg_" + k, v); } catch { /* ignore */ } }
  };

  const params = new URLSearchParams(location.search);
  const state = {
    site: null,
    lang: params.get("lang") || store.get("lang") || guessLang(),
    view: store.get("view") || "iso",
    tilt: (store.get("view") || "iso") === "iso" ? 1 : 0,   // 0 = flat 2D … 1 = 3D
    ang: Number(store.get("ang")) || 0,                     // map turned by this many degrees
    dayMode: store.get("day") || "auto",                    // auto | day | night
    follow: store.get("follow") === "1",                    // turn the map to the walking direction
    selB: null, rise: true, anim: false,
    safety: false,
    here: params.get("here"),
    route: null,      // { from, to, path:[nodeIds], steps:[], dist }
    step: 0,
    vb: null, baseVb: null,
    // route options; avoiding restricted areas is on unless the person turned it off
    opts: {
      covered: store.get("optCovered") === "1",
      stepFree: store.get("optStepFree") === "1",
      noRestricted: store.get("optNoRestricted") !== "0"
    },
    heading: null,    // compass heading in degrees (null = no compass)
    emergency: null,  // { drill, t0, done } while emergency mode is on
    facilities: false // Facilities layer (toilets, water…) on the map
  };

  function guessLang() {
    const l = (navigator.language || "en").toLowerCase();
    if (l.startsWith("ms") || l.startsWith("id")) return "ms";
    if (l.startsWith("zh")) return "zh";
    return "en";
  }

  /* ---------- text helpers ---------- */
  const t = (key, vars) => {
    let s = (I18N[state.lang] && I18N[state.lang][key]) || (I18N.en && I18N.en[key]) || key;
    if (vars) for (const k in vars) s = s.replace("{" + k + "}", vars[k]);
    return s;
  };
  const L = (obj) => (obj ? (typeof obj === "string" ? obj : obj[state.lang] || obj.en || "") : "");

  /* ---------- icons ---------- */
  const ICON = {
    gate: ["🚪", "#0f2a3d"], security: ["🛡️", "#0f2a3d"], bus: ["🚌", "#1565c0"], lobby: ["🛎️", "#0e8a7e"],
    meeting: ["👥", "#0e8a7e"], office: ["🏢", "#0e8a7e"], clinic: ["➕", "#c62d2d"], food: ["🍽️", "#d3812a"],
    prayer: ["🕌", "#2e7d4f"], parking: ["🅿️", "#3949ab"], moto: ["🛵", "#3949ab"], factory: ["🏭", "#455a64"],
    truck: ["🚚", "#6a4fb0"], assembly: ["AP", "#2e9d4a"],
    // everyday facilities (shown with the Facilities layer, and by the "Nearest" buttons)
    toilet: ["🚻", "#00838f"], water: ["🚰", "#0277bd"], atm: ["🏧", "#2e7d32"], locker: ["🔐", "#5d4037"],
    smoking: ["🚬", "#757575"], nursing: ["🍼", "#ad1457"], vending: ["🥤", "#ef6c00"]
  };

  // direction icons (24×24 stroke paths), used in the step card, step list and map badge
  const MAN = {
    start: ["M12 4.5a7.5 7.5 0 1 0 0 15a7.5 7.5 0 1 0 0-15Z", "M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4Z"],
    left: ["M16 21v-7a5 5 0 0 0-5-5H4.5", "M8.5 5 4.5 9l4 4"],
    right: ["M8 21v-7a5 5 0 0 1 5-5h6.5", "M15.5 5l4 4-4 4"],
    arrive: ["M6 21V3.5", "M6 4h12l-3 4.5 3 4.5H6"]
  };
  const FACILITY = ["toilet", "water", "atm", "locker", "smoking", "nursing", "vending"];
  // "Nearest …" buttons, in this order, for the types a site has
  const NEAREST = ["toilet", "water", "food", "prayer", "clinic", "atm", "vending", "locker", "nursing", "smoking"];
  const manSvg = (kind) => `<svg viewBox="0 0 24 24" aria-hidden="true">${(MAN[kind] || []).map((d) => `<path d="${d}"/>`).join("")}</svg>`;
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- projection ----------
     The map can turn (state.ang, degrees; 0 = north up) and tilt (state.tilt:
     0 = flat 2D plan, 1 = 3D). 3D is the classic isometric view: the plan
     turned 45° more, stretched sideways and squashed, with heights going up. */
  let VIEW = { cx: 0, cy: 0, c: 1, s: 0, sx: 1, sy: 1, t: 0 };
  function setProjection() {
    const site = state.site || {}, t = state.tilt;
    const xs = (site.boundary || [[0, 0]]).map((p) => p[0]), ys = (site.boundary || [[0, 0]]).map((p) => p[1]);
    const a = ((state.ang + 45 * t) * Math.PI) / 180;
    VIEW = { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2,
      c: Math.cos(a), s: Math.sin(a), sx: 1 + 0.2247 * t, sy: 1 - 0.2929 * t, t };
  }
  function P(x, y, z = 0) {
    const dx = x - VIEW.cx, dy = y - VIEW.cy;
    return [(dx * VIEW.c - dy * VIEW.s) * VIEW.sx, (dx * VIEW.s + dy * VIEW.c) * VIEW.sy - z * VIEW.t];
  }
  // how near the viewer a ground point is (bigger = nearer, drawn later)
  const depth = (x, y) => (x - VIEW.cx) * VIEW.s + (y - VIEW.cy) * VIEW.c;
  // a wall facing outwards along (nx, ny) can be seen when it faces down the screen
  const facesViewer = (nx, ny) => nx * VIEW.s + ny * VIEW.c > 0.001;
  // wall light: walls facing screen-left are brighter, like the sun is up-left
  const wallLight = (nx, ny) => 0.7 - 0.16 * (nx * VIEW.c - ny * VIEW.s);
  const pts = (arr) => arr.map((p) => P(p[0], p[1], p[2] || 0).map((n) => n.toFixed(1)).join(",")).join(" ");

  function el(name, attrs = {}, parent) {
    const e = document.createElementNS(svgNS, name);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.round(Math.min(255, Math.max(0, r * f)));
    g = Math.round(Math.min(255, Math.max(0, g * f)));
    b = Math.round(Math.min(255, Math.max(0, b * f)));
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  /* =================================================================
     ROUTING (Dijkstra on the walkway graph)
     ================================================================= */
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  /* Walkway tags: ["a", "b", "covered", "stairs", "restricted"] (any order, all optional). */
  const UNCOVERED_COST = 3; // with "covered" on, an open-air metre counts as 3 sheltered metres
  function edgeTags(site, a, b) {
    if (!site._tags) {
      site._tags = {};
      for (const [x, y, ...tags] of site.edges) site._tags[x + "|" + y] = site._tags[y + "|" + x] = tags;
    }
    return site._tags[a + "|" + b] || [];
  }

  function shortestPath(site, start, goal, opts = {}) {
    if (start === goal) return [start];
    const adj = {};
    for (const [a, b, ...tags] of site.edges) {
      if (!site.nodes[a] || !site.nodes[b]) continue;
      if (opts.stepFree && tags.includes("stairs")) continue;
      if (opts.noRestricted && tags.includes("restricted")) continue;
      let w = dist(site.nodes[a], site.nodes[b]);
      if (opts.covered && !tags.includes("covered")) w *= UNCOVERED_COST;
      (adj[a] = adj[a] || []).push([b, w]);
      (adj[b] = adj[b] || []).push([a, w]);
    }
    const d = { [start]: 0 }, prev = {}, done = new Set();
    const queue = [start];
    while (queue.length) {
      queue.sort((a, b) => d[a] - d[b]);
      const u = queue.shift();
      if (done.has(u)) continue;
      done.add(u);
      if (u === goal) break;
      for (const [v, w] of adj[u] || []) {
        const nd = d[u] + w;
        if (d[v] === undefined || nd < d[v]) { d[v] = nd; prev[v] = u; queue.push(v); }
      }
    }
    if (d[goal] === undefined) return null;
    const path = [goal];
    while (path[0] !== start) path.unshift(prev[path[0]]);
    return path;
  }

  function pathLength(site, path) {
    let s = 0;
    for (let i = 1; i < path.length; i++) s += dist(site.nodes[path[i - 1]], site.nodes[path[i]]);
    return s;
  }

  /* Build human directions from a node path. */
  function buildSteps(site, path, fromPoi, toPoi) {
    const N = (id) => site.nodes[id];
    const steps = [{ node: path[0], kind: "start", text: t("start", { a: L(fromPoi.label) }), seg: [0, 0], dist: 0 }];
    if (path.length === 1) return steps;
    let acc = 0, segStart = 0;
    for (let i = 1; i < path.length; i++) {
      acc += dist(N(path[i - 1]), N(path[i]));
      if (i === path.length - 1) break;
      const a = N(path[i - 1]), b = N(path[i]), c = N(path[i + 1]);
      const v1 = [b.x - a.x, b.y - a.y], v2 = [c.x - b.x, c.y - b.y];
      const cross = v1[0] * v2[1] - v1[1] * v2[0];
      const dot = v1[0] * v2[0] + v1[1] * v2[1];
      const ang = Math.atan2(cross, dot) * 180 / Math.PI;
      if (Math.abs(ang) < 25) continue; // going straight: keep accumulating
      const dir = ang > 0 ? "right" : "left"; // y grows downward, so positive cross = clockwise = right
      const where = b.label ? t(dir, { a: L(b.label) }) : t(dir + "Plain");
      steps.push({
        node: path[i], kind: dir, seg: [segStart, i], dist: acc,
        text: t("straight", { d: Math.max(5, Math.round(acc / 5) * 5) }) + " " + where
      });
      acc = 0; segStart = i;
    }
    steps.push({
      node: path[path.length - 1], kind: "arrive", seg: [segStart, path.length - 1], dist: acc,
      text: t("straight", { d: Math.max(5, Math.round(acc / 5) * 5) }) + " " + t("arrive", { a: L(toPoi.label) }),
      note: toPoi.note ? L(toPoi.note) : "", restricted: !!toPoi.restricted
    });
    return steps;
  }

  /* =================================================================
     TEMPORARY PHOTO (illustrated placeholder until real photos arrive)
     Real photos are picked up automatically from photos/<site>/<node>.jpg
     ================================================================= */
  function placeholderPhoto(site, step) {
    const node = site.nodes[step.node] || {};
    const title = node.label ? L(node.label) : step.poi ? L(step.poi.label) : step.kind === "start" ? L(state.route.fromPoi.label) : step.kind === "arrive" ? L(state.route.toPoi.label) : "";
    const hue = { start: 205, left: 165, right: 165, arrive: 140 }[step.kind] || 200;
    const arrow = {
      start: '<circle cx="320" cy="250" r="34" fill="#1e88e5" stroke="#fff" stroke-width="6"/><circle cx="320" cy="250" r="10" fill="#fff"/>',
      left: '<path d="M370 330 V250 Q370 220 340 220 H250" fill="none" stroke="#ff6a13" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/><path d="M265 180 L205 220 L265 260 Z" fill="#ff6a13"/>',
      right: '<path d="M270 330 V250 Q270 220 300 220 H390" fill="none" stroke="#ff6a13" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/><path d="M375 180 L435 220 L375 260 Z" fill="#ff6a13"/>',
      arrive: '<path d="M300 320 V170" stroke="#fff" stroke-width="10"/><path d="M300 172 L380 195 L300 220 Z" fill="#2e9d4a" stroke="#fff" stroke-width="5"/><ellipse cx="300" cy="322" rx="34" ry="10" fill="rgba(0,0,0,.25)"/>'
    }[step.kind] || "";
    const safe = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    return `
<svg viewBox="0 0 640 400" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${safe(title)}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,78%)"/><stop offset="1" stop-color="hsl(${hue},40%,92%)"/></linearGradient>
    <linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fb5a2"/><stop offset="1" stop-color="#6f8a74"/></linearGradient>
  </defs>
  <rect width="640" height="400" fill="url(#sky)"/>
  <rect y="190" width="640" height="210" fill="url(#gr)"/>
  <polygon points="0,120 230,160 230,215 0,300" fill="#7d93a8"/><polygon points="0,120 230,160 230,170 0,140" fill="#5f7489"/>
  <polygon points="640,110 410,158 410,215 640,305" fill="#8aa0b4"/><polygon points="640,110 410,158 410,168 640,130" fill="#6b8196"/>
  ${[0, 1, 2, 3].map((i) => `<rect x="${40 + i * 45}" y="${185 + i * 4}" width="22" height="${46 - i * 6}" fill="rgba(255,255,255,.35)"/>`).join("")}
  ${[0, 1, 2, 3].map((i) => `<rect x="${580 - i * 45}" y="${185 + i * 4}" width="22" height="${46 - i * 6}" fill="rgba(255,255,255,.35)"/>`).join("")}
  <polygon points="250,200 390,200 560,400 80,400" fill="#d9dde0"/>
  <polygon points="314,200 326,200 340,400 300,400" fill="#f3d34a" opacity=".9"/>
  ${arrow}
  <rect x="16" y="72" rx="10" width="${Math.min(608, 24 + title.length * 13)}" height="44" fill="rgba(15,42,61,.85)"/>
  <text x="30" y="102" font-family="Segoe UI, system-ui, sans-serif" font-size="22" font-weight="700" fill="#fff">${safe(title)}</text>
</svg>`;
  }

  function renderPhoto(site, step) {
    const fig = $("stepPhoto");
    fig.innerHTML = "";
    const node = site.nodes[step.node] || {};
    const realPath = node.photo || `photos/${site.id}/${step.node}.jpg`;
    const img = new Image();
    img.alt = "";
    img.onload = () => { fig.innerHTML = ""; fig.appendChild(img); };
    img.onerror = () => {
      fig.innerHTML = placeholderPhoto(site, step) +
        `<figcaption>${t("tempPhoto")} · ${t("replaceWith")} ${realPath}</figcaption>`;
    };
    img.src = realPath;
  }

  /* =================================================================
     MAP RENDERING
     ================================================================= */
  const svg = $("map");

  function computeBounds(site) {
    setProjection();
    const all = [];
    site.boundary.forEach(([x, y]) => all.push(P(x, y, 0)));
    (site.buildings || []).forEach((b) => {
      [[b.x, b.y], [b.x + b.w, b.y], [b.x, b.y + b.d], [b.x + b.w, b.y + b.d]].forEach(([x, y]) => all.push(P(x, y, b.h)));
    });
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    const pad = 24;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad - 10, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 + 10 };
  }

  function setViewBox() {
    const v = state.vb;
    svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  }

  /* ---------- scenery helpers ---------- */
  // stable pseudo-random 0…1 from a seed, so trees and cars stay put between redraws
  function rnd(seed) {
    let h = 2166136261;
    for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return ((h >>> 0) % 10000) / 10000;
  }
  const isNight = () => state.dayMode === "night" || (state.dayMode === "auto" && (new Date().getHours() >= 19 || new Date().getHours() < 7));
  const inRect = (x, y, r, m) => x > r.x - m && x < r.x + r.w + m && y > r.y - m && y < r.y + r.d + m;
  function segDist(px, py, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
    const k = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2));
    return Math.hypot(px - a.x - k * dx, py - a.y - k * dy);
  }
  const segments = (site) => site.edges.map(([a, b, ...tags]) => [site.nodes[a], site.nodes[b], tags]).filter(([a, b]) => a && b);

  // trees on open ground: not on buildings, car parks or walkways (worked out once per site)
  function siteTrees(site) {
    if (site._trees) return site._trees;
    const xs = site.boundary.map((p) => p[0]), ys = site.boundary.map((p) => p[1]);
    const segs = segments(site), out = [];
    for (let x = Math.min(...xs) + 5; x < Math.max(...xs) - 3; x += 13) {
      for (let y = Math.min(...ys) + 5; y < Math.max(...ys) - 3; y += 13) {
        if (rnd("keep" + x + "," + y) > 0.55) continue;
        const tx = x + (rnd("tx" + x + "," + y) - 0.5) * 7, ty = y + (rnd("ty" + x + "," + y) - 0.5) * 7;
        if ((site.buildings || []).some((b) => inRect(tx, ty, b, 4))) continue;
        if ((site.areas || []).some((a) => a.d && a.type !== "green" && inRect(tx, ty, a, 3))) continue;
        if (segs.some(([a, b]) => segDist(tx, ty, a, b) < 6.5)) continue;
        out.push({ x: tx, y: ty, s: 0.8 + rnd("s" + tx) * 0.5 });
      }
    }
    return (site._trees = out.slice(0, 90));
  }

  // parked cars in rows inside each car park
  const CAR_COLORS = ["#d9dde1", "#2b2f33", "#9aa3ab", "#b3261e", "#1f4e8c", "#f2f2f2", "#5b6670", "#7a5c3a"];
  function siteCars(site) {
    if (site._cars) return site._cars;
    const out = [];
    for (const a of site.areas || []) {
      if (a.type !== "parking" || !a.d || /moto/i.test(L(a.label) + (a.label && a.label.en))) continue;
      const along = a.d >= a.w; // stalls line up along the long side
      const rowsLen = along ? a.w : a.d, stallLen = along ? a.d : a.w;
      for (let r = 1; r + 4.6 < rowsLen; r += 7) {
        for (let s = 1; s + 2.2 < stallLen; s += 2.8) {
          if (rnd(a.x + "car" + r + "," + s) > 0.55) continue;
          const c = CAR_COLORS[Math.floor(rnd("col" + r + s + a.y) * CAR_COLORS.length)];
          out.push(along ? { x0: a.x + r, y0: a.y + s + 0.4, x1: a.x + r + 4.4, y1: a.y + s + 2.2, c } : { x0: a.x + s + 0.4, y0: a.y + r, x1: a.x + s + 2.2, y1: a.y + r + 4.4, c });
        }
      }
    }
    return (site._cars = out.slice(0, 45));
  }

  // street lamps beside the longer walkways
  function siteLamps(site) {
    if (site._lamps) return site._lamps;
    const out = [];
    for (const [a, b, tags] of segments(site)) {
      const len = dist(a, b);
      if (len < 22 || tags.includes("covered") || tags.includes("restricted")) continue;
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      for (let d = 10; d < len - 5; d += 32) {
        const x = a.x + ((b.x - a.x) * d) / len + nx * 4, y = a.y + ((b.y - a.y) * d) / len + ny * 4;
        if ((site.buildings || []).some((bl) => inRect(x, y, bl, 1))) continue;
        out.push({ x, y });
      }
    }
    return (site._lamps = out.slice(0, 40));
  }

  /* A prism: corners clockwise on the map (y down), walls that face the viewer, then the roof.
     Returns the visible walls so windows and doors can go on them. */
  function drawPrism(g, corners, z0, h, color, o = {}) {
    const dim = o.night ? 0.55 : 1, walls = [];
    if (VIEW.t > 0.02 && h > 0) {
      for (let i = 0; i < corners.length; i++) {
        const A = corners[i], B = corners[(i + 1) % corners.length];
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
        const nx = (B[1] - A[1]) / len, ny = -(B[0] - A[0]) / len;
        if (!facesViewer(nx, ny)) continue;
        el("polygon", { points: pts([[A[0], A[1], z0], [B[0], B[1], z0], [B[0], B[1], z0 + h], [A[0], A[1], z0 + h]]), fill: shade(color, wallLight(nx, ny) * dim), stroke: shade(color, 0.55 * dim), "stroke-width": o.thin ? 0.3 : 0.6 }, g);
        walls.push({ A, B, nx, ny, len });
      }
    }
    el("polygon", { points: pts(corners.map(([x, y]) => [x, y, z0 + h])), fill: shade(color, (o.roof || 1.12) * dim), stroke: shade(color, 0.7 * dim), "stroke-width": o.thin ? 0.3 : 0.8 }, g);
    return walls;
  }
  const rectCorners = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

  // point s (0…1) along a wall at height z, as "x,y"
  const onWall = (w, s, z) => P(w.A[0] + (w.B[0] - w.A[0]) * s, w.A[1] + (w.B[1] - w.A[1]) * s, z).map((n) => n.toFixed(1)).join(",");
  const wallQuad = (w, s0, s1, z0, z1) => `M${onWall(w, s0, z0)}L${onWall(w, s1, z0)}L${onWall(w, s1, z1)}L${onWall(w, s0, z1)}Z`;

  // rows of windows on a wall (lit ones glow at night)
  function wallWindows(w, h, seed, lit, dark) {
    const floors = Math.max(1, Math.floor(h / 4.2)), cols = Math.floor((w.len - 3) / 4);
    if (cols < 1 || h < 3.5) return;
    const off = (w.len - cols * 4) / 2 + 0.9;
    for (let f = 0; f < floors; f++) {
      const z0 = f * 4.2 + 1.3, z1 = z0 + 1.7;
      if (z1 > h - 0.6) continue;
      for (let c = 0; c < cols; c++) {
        const q = wallQuad(w, (off + c * 4) / w.len, (off + c * 4 + 2.2) / w.len, z0, z1);
        (rnd(seed + f + "-" + c + w.nx + w.ny) < 0.45 ? lit : dark).push(q);
      }
    }
  }

  // doors where a walkway point with a place sits right against a wall
  function wallDoors(g, w, doorNodes) {
    for (const n of doorNodes) {
      const dx = w.B[0] - w.A[0], dy = w.B[1] - w.A[1];
      const s = ((n.x - w.A[0]) * dx + (n.y - w.A[1]) * dy) / (w.len * w.len);
      const off = Math.abs((n.x - w.A[0]) * w.nx + (n.y - w.A[1]) * w.ny);
      if (s < 0.04 || s > 0.96 || off > 8) continue;
      const half = (n.truck ? 2.6 : 1.3) / w.len;
      el("path", { d: wallQuad(w, s - half, s + half, 0, n.truck ? 4.2 : 2.6), class: n.truck ? "door roller" : "door" }, g);
    }
  }

  /* =================================================================
     THE MAP
     ================================================================= */
  function renderMap() {
    const site = state.site;
    svg.innerHTML = "";
    if (!site.buildings) return;
    setProjection();
    const night = isNight(), lite = !!state.anim, flat = VIEW.t < 0.02;
    document.querySelector(".mapwrap").classList.toggle("night", night);

    const defs = el("defs", {}, svg);
    const hatch = el("pattern", { id: "hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
    el("rect", { width: 6, height: 6, fill: "rgba(198,45,45,.18)" }, hatch);
    el("line", { x1: 0, y1: 0, x2: 0, y2: 6, stroke: "rgba(198,45,45,.75)", "stroke-width": 2 }, hatch);
    const glow = el("radialGradient", { id: "lampGlow" }, defs);
    el("stop", { offset: "0", "stop-color": "#ffe8a3", "stop-opacity": ".55" }, glow);
    el("stop", { offset: "1", "stop-color": "#ffe8a3", "stop-opacity": "0" }, glow);

    const gGround = el("g", {}, svg), gRoad = el("g", {}, svg), gArea = el("g", {}, svg), gShadow = el("g", { class: "shadows" }, svg);
    const gRoute = el("g", {}, svg), gBld = el("g", {}, svg), gBus = el("g", {}, svg), gOver = el("g", {}, svg);
    const gPoi = el("g", {}, svg), gTop = el("g", {}, svg);

    // ground
    el("polygon", { points: pts(site.boundary), fill: "var(--ground)", stroke: "#7f9a86", "stroke-width": 1.5, "stroke-dasharray": "6 4" }, gGround);
    for (const a of site.areas || []) if (a.type === "green" && a.d) el("polygon", { points: pts(rectCorners(a.x, a.y, a.x + a.w, a.y + a.d)), class: "grass" }, gGround);

    // roads / walkways
    const markings = [];
    for (const [A, B, tags] of segments(site)) {
      const pa = P(A.x, A.y), pb = P(B.x, B.y);
      const d = `M${pa.join(",")} L${pb.join(",")}`;
      el("path", { d, stroke: tags.includes("covered") ? "#3f9c8f" : "var(--road-edge)", "stroke-width": 10, "stroke-linecap": "round", fill: "none" }, gRoad);
      el("path", { d, stroke: "var(--road)", "stroke-width": 7, "stroke-linecap": "round", fill: "none" }, gRoad);
      if (tags.includes("covered")) el("path", { d, class: "walk-covered" }, gRoad);
      if (tags.includes("restricted")) el("path", { d, class: "walk-restricted" }, gRoad);
      if (!tags.length && dist(A, B) > 25) markings.push(d);
      if (tags.includes("stairs")) {
        // three short treads across the middle of the walkway
        const ang = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) * 180 / Math.PI;
        const mx = (pa[0] + pb[0]) / 2, my = (pa[1] + pb[1]) / 2;
        el("path", { d: "M-3,-3.5 V3.5 M0,-3.5 V3.5 M3,-3.5 V3.5", class: "walk-stairs", transform: `translate(${mx.toFixed(1)},${my.toFixed(1)}) rotate(${ang.toFixed(1)})` }, gRoad);
      }
    }
    if (markings.length && !lite) el("path", { d: markings.join(" "), class: "road-marking" }, gRoad);

    // flat areas: car parks with bay lines, assembly points
    for (const a of site.areas || []) {
      if (!a.d || a.type === "green") continue;
      const poly = rectCorners(a.x, a.y, a.x + a.w, a.y + a.d);
      if (a.type === "parking") {
        el("polygon", { points: pts(poly), class: "park" }, gArea);
        if (!lite) {
          const along = a.d >= a.w, lines = [];
          const rowsLen = along ? a.w : a.d, stallLen = along ? a.d : a.w;
          for (let r = 0.5; r + 5 < rowsLen; r += 7) for (let s = 0.6; s < stallLen - 0.5; s += 2.8) {
            const [x0, y0, x1, y1] = along ? [a.x + r, a.y + s, a.x + r + 5, a.y + s] : [a.x + s, a.y + r, a.x + s, a.y + r + 5];
            lines.push(`M${P(x0, y0).join(",")}L${P(x1, y1).join(",")}`);
          }
          el("path", { d: lines.join(""), class: "bay-lines" }, gArea);
        }
      }
      if (a.type === "assembly") el("polygon", { points: pts(poly), fill: "rgba(46,157,74,.28)", stroke: "#2e9d4a", "stroke-width": 1.5, "stroke-dasharray": "4 3" }, gArea);
      if (a.label) {
        const c = P(a.x + a.w / 2, a.y + a.d / 2);
        el("text", { x: c[0], y: c[1] + 3, class: "lbl small", "text-anchor": "middle" }, gArea).textContent = L(a.label);
      }
    }

    // places at doors (doors get drawn on walls next to them)
    const doorNodes = [];
    for (const p of site.pois || []) {
      const n = site.nodes[p.node];
      if (n && !doorNodes.some((d) => d.x === n.x && d.y === n.y)) doorNodes.push({ x: n.x, y: n.y, truck: p.type === "truck" });
    }
    const destB = destinationBuilding();
    const rise = state.rise && !reduceMotion() && !lite;
    state.rise = false;

    /* Everything that stands up is drawn far → near (painter's order). */
    const items = [];

    // buildings with windows, doors, roof units, solar panels
    (site.buildings || []).forEach((b, bi) => {
      const x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.d, h = b.h;
      // shadow on the ground, falling towards the lower right
      if (!flat) {
        const sh = rectCorners(x0, y0, x1, y1).flatMap(([x, y]) => { const p = P(x, y, 0); return [p, [p[0] + h * 0.55 * VIEW.t, p[1] + h * 0.3 * VIEW.t]]; });
        el("polygon", { points: hull(sh).map((p) => p.map((n) => n.toFixed(1)).join(",")).join(" "), class: "bshadow" }, gShadow);
      }
      items.push({ d: depth(b.x + b.w / 2, b.y + b.d / 2), draw: (gParent) => {
        const cls = "bld" + (state.selB === b.id ? " sel" : "") + (destB === b.id ? " dest" : "") + (rise ? " rise" : "");
        const g = el("g", { "data-b": b.id, class: cls, style: rise ? `animation-delay:${bi * 70}ms` : null }, gParent);
        const walls = drawPrism(g, rectCorners(x0, y0, x1, y1), 0, h, b.color, { night });
        if (!lite && !flat) {
          const lit = [], dark = [];
          for (const w of walls) wallWindows(w, h, b.id, lit, dark);
          if (dark.length) el("path", { d: dark.join(""), class: "win" }, g);
          if (lit.length) el("path", { d: lit.join(""), class: night ? "win lit" : "win" }, g);
          for (const w of walls) wallDoors(g, w, doorNodes);
          // roof: parapet line, air-con units, solar panels on big roofs
          if (b.w > 20 && b.d > 16) el("polygon", { points: pts(rectCorners(x0 + 2.5, y0 + 2.5, x1 - 2.5, y1 - 2.5).map(([x, y]) => [x, y, h])), fill: "none", stroke: "rgba(255,255,255,.35)", "stroke-width": 0.7 }, g);
          if (b.w * b.d > 6000) {
            const sx0 = x0 + 6, sx1 = x0 + b.w * 0.42, sy0 = y0 + 6, sy1 = y1 - 6, rows = [];
            el("polygon", { points: pts(rectCorners(sx0, sy0, sx1, sy1).map(([x, y]) => [x, y, h + 0.3])), class: "solar" }, g);
            for (let y = sy0 + 4; y < sy1; y += 4) rows.push(`M${P(sx0, y, h + 0.3).join(",")}L${P(sx1, y, h + 0.3).join(",")}`);
            for (let x = sx0 + 6; x < sx1; x += 6) rows.push(`M${P(x, sy0, h + 0.3).join(",")}L${P(x, sy1, h + 0.3).join(",")}`);
            el("path", { d: rows.join(""), class: "solar-grid" }, g);
          }
          const units = Math.max(1, Math.min(5, Math.round((b.w * b.d) / 2200)));
          for (let k = 0; k < units && b.w > 12 && b.d > 10; k++) {
            const ux = x1 - 6 - rnd(b.id + "ux" + k) * (b.w * 0.45), uy = y0 + 3 + rnd(b.id + "uy" + k) * (b.d - 7);
            drawPrism(g, rectCorners(ux, uy, ux + 3, uy + 2.2), h, 1.5, "#b7c0c8", { thin: true, roof: 1.05, night });
          }
        }
        if (b.label) {
          const c = P(x0 + b.w / 2, y0 + b.d / 2, h);
          el("text", { x: c[0], y: c[1] + 3, class: "lbl" + (b.w < 30 ? " small" : ""), "text-anchor": "middle" }, g).textContent = L(b.label);
        }
        // restricted zones on this building's roof
        for (const r of site.restricted || []) {
          if (r.building !== b.id) continue;
          if (!state.safety && !(state.route && state.route.toPoi.restricted)) continue;
          el("polygon", { points: pts([[r.x, r.y, h + 0.2], [r.x + r.w, r.y, h + 0.2], [r.x + r.w, r.y + r.d, h + 0.2], [r.x, r.y + r.d, h + 0.2]]), fill: "url(#hatch)", stroke: "#c62d2d", "stroke-width": 1.2 }, g);
          const c = P(r.x + r.w / 2, r.y + r.d / 2 + 8, h);
          el("text", { x: c[0], y: c[1], class: "lbl small", "text-anchor": "middle", fill: "#8e1c1c" }, g).textContent = "⛔ " + L(r.label).split(" — ")[0];
        }
      } });
    });

    // covered walkways get a canopy on posts (not where they run inside a building)
    for (const [A, B, tags] of segments(site)) {
      if (!tags.includes("covered") || flat) continue;
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      if ((site.buildings || []).some((b) => inRect(mx, my, b, -0.5))) continue;
      const len = dist(A, B), nx = (-(B.y - A.y) / len) * 1.7, ny = ((B.x - A.x) / len) * 1.7;
      items.push({ d: depth(mx, my), draw: (g) => {
        const posts = [];
        for (let s = 0; s <= len; s += 6) for (const k of [-1, 1]) {
          const x = A.x + ((B.x - A.x) * s) / len + nx * k, y = A.y + ((B.y - A.y) * s) / len + ny * k;
          posts.push(`M${P(x, y, 0).join(",")}L${P(x, y, 3.2).join(",")}`);
        }
        el("path", { d: posts.join(""), class: "canopy-post" }, g);
        el("polygon", { points: pts([[A.x + nx, A.y + ny, 3.2], [B.x + nx, B.y + ny, 3.2], [B.x - nx, B.y - ny, 3.2], [A.x - nx, A.y - ny, 3.2]]), class: "canopy" }, g);
      } });
    }

    // perimeter fence: posts and two rails along each side
    if (!flat) site.boundary.forEach((A, i) => {
      const B = site.boundary[(i + 1) % site.boundary.length];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
      items.push({ d: depth((A[0] + B[0]) / 2, (A[1] + B[1]) / 2) - 1e4 * (facesViewer((B[1] - A[1]) / len, -(B[0] - A[0]) / len) ? -1 : 1), draw: (g) => {
        const d = [];
        for (const z of [0.7, 1.7]) d.push(`M${P(A[0], A[1], z).join(",")}L${P(B[0], B[1], z).join(",")}`);
        if (!lite) for (let s = 0; s <= len; s += 6) { const x = A[0] + ((B[0] - A[0]) * s) / len, y = A[1] + ((B[1] - A[1]) * s) / len; d.push(`M${P(x, y, 0).join(",")}L${P(x, y, 1.8).join(",")}`); }
        el("path", { d: d.join(""), class: "fence" }, g);
      } });
    });

    if (!lite) {
      // trees
      for (const tr of siteTrees(site)) items.push({ d: depth(tr.x, tr.y), draw: (g) => {
        const base = P(tr.x, tr.y, 0), top = P(tr.x, tr.y, 4.3 * tr.s), r = 2.9 * tr.s * (1 + 0.25 * VIEW.t);
        if (!flat) el("ellipse", { cx: base[0] + 2.2 * VIEW.t, cy: base[1] + 1, rx: r * 0.9, ry: r * 0.45, class: "tshadow" }, gShadow);
        if (!flat) el("line", { x1: base[0], y1: base[1], x2: top[0], y2: top[1] + r * 0.6, class: "trunk" }, g);
        el("circle", { cx: top[0], cy: top[1], r, class: "crown" + (rnd("c" + tr.x) > 0.5 ? " alt" : "") }, g);
        el("circle", { cx: top[0] - r * 0.35, cy: top[1] - r * 0.35, r: r * 0.45, class: "crown-hi" }, g);
      } });
      // parked cars
      for (const c of siteCars(site)) items.push({ d: depth((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2), draw: (g) => {
        drawPrism(g, rectCorners(c.x0, c.y0, c.x1, c.y1), 0, flat ? 0 : 1.4, c.c, { thin: true, roof: 1.2, night });
      } });
      // street lamps (they glow at night)
      for (const lp of siteLamps(site)) items.push({ d: depth(lp.x, lp.y), draw: (g) => {
        const b = P(lp.x, lp.y, 0), tp = P(lp.x, lp.y, flat ? 0 : 5.5);
        if (night) el("ellipse", { cx: b[0], cy: b[1], rx: 11, ry: 6 + 5 * (1 - VIEW.t), fill: "url(#lampGlow)" }, gShadow);
        if (!flat) el("line", { x1: b[0], y1: b[1], x2: tp[0], y2: tp[1], class: "lamp-pole" }, g);
        el("circle", { cx: tp[0], cy: tp[1], r: 1.4, class: night ? "lamp on" : "lamp" }, g);
      } });
      // gate barrier that lifts now and then
      const gate = (site.pois || []).find((p) => p.type === "gate");
      const gn = gate && site.nodes[gate.node];
      const nb = gn && segments(site).find(([a, b]) => a === gn || b === gn);
      if (gn && nb && !flat) {
        const other = nb[0] === gn ? nb[1] : nb[0], len = dist(gn, other) || 1;
        const px = -(other.y - gn.y) / len, py = (other.x - gn.x) / len; // across the road
        const pivot = [gn.x + px * 3.6, gn.y + py * 3.6], end = [gn.x - px * 3.4, gn.y - py * 3.4];
        items.push({ d: depth(gn.x, gn.y) + 0.5, draw: (g) => {
          drawPrism(g, rectCorners(pivot[0] - 0.4, pivot[1] - 0.4, pivot[0] + 0.4, pivot[1] + 0.4), 0, 1.2, "#e0b400", { thin: true, night });
          const a = P(pivot[0], pivot[1], 1.1), b = P(end[0], end[1], 1.1);
          const arm = el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: "barrier-arm" + (reduceMotion() ? "" : " moving") }, g);
          arm.style.transformOrigin = `${a[0]}px ${a[1]}px`;
          arm.style.setProperty("--lift", b[0] > a[0] ? "-62deg" : "62deg");
        } });
      }
    }

    items.sort((a, b) => a.d - b.d).forEach((it) => it.draw(gBld));
    busLayer = gBus;

    // route: done part grey, rest soft orange, current leg bright with flowing chevrons
    const fresh = state.fresh && !lite;
    if (!lite) state.fresh = false;
    if (state.route && state.route.path.length > 1) {
      const path = state.route.path;
      const line = (a, b) => path.slice(a, b + 1).map((id, i) => (i ? "L" : "M") + P(site.nodes[id].x, site.nodes[id].y).join(",")).join(" ");
      const [s0, s1] = legRange();
      const full = line(0, path.length - 1);
      el("path", { d: full, class: "route-under" }, gRoute);
      el("path", { d: full, class: "route-ahead" }, gRoute);
      if (s0 > 0) el("path", { d: line(0, s0), class: "route-done" }, gRoute);
      const leg = el("path", { d: line(s0, s1), class: "route-leg" }, gRoute);
      if (fresh && !reduceMotion()) {
        const len = leg.getTotalLength();
        leg.style.strokeDasharray = len;
        leg.style.strokeDashoffset = len;
        leg.classList.add("draw");
      }
      chevrons(gRoute, path.slice(s0, s1 + 1));
      // also draw on top of buildings at low opacity so it never hides
      el("path", { d: line(s0, s1), class: "route-leg", opacity: 0.4 }, gOver);
    }

    // safety markers
    if (state.safety) {
      for (const s of site.safety || []) {
        const p = P(s.x, s.y, 0);
        const cfg = { exit: ["#2e9d4a", "⇥"], ext: ["#c62d2d", "F"], aed: ["#d81b60", "♥"], eyewash: ["#0288d1", "👁"] }[s.type] || ["#555", "?"];
        const g = el("g", { class: "safety-m " + s.type }, gTop);
        el("rect", { x: p[0] - 6, y: p[1] - 6, width: 12, height: 12, rx: 3, fill: cfg[0], stroke: "#fff", "stroke-width": 1.2 }, g);
        el("text", { x: p[0], y: p[1] + 3.5, "text-anchor": "middle", "font-size": 9, fill: "#fff", "font-weight": 700 }, g).textContent = cfg[1];
      }
    }

    // POIs (stack ones sharing a node)
    const byNode = {};
    for (const p of site.pois) (byNode[p.node] = byNode[p.node] || []).push(p);
    const r = state.route;
    for (const nodeId in byNode) {
      const node = site.nodes[nodeId];
      if (!node) continue;
      const endOf = (poi) => r && (r.fromPoi.id === poi.id || r.toPoi.id === poi.id || (r.tour && r.tour.stops.includes(poi.id)));
      // safety places only with the Safety layer, facilities only with the Facilities layer (or when routed to)
      const shown = byNode[nodeId].filter((poi) =>
        (!poi.safety || state.safety || (r && r.toPoi.id === poi.id)) &&
        (!FACILITY.includes(poi.type) || state.facilities || endOf(poi)));
      const main = shown.filter((p) => !FACILITY.includes(p.type)), fac = shown.filter((p) => FACILITY.includes(p.type));
      // main places stack upwards; facilities sit in a small row beside the walkway point
      [...main.map((p, i) => [p, 0, 16 + i * 17, 8]), ...fac.map((p, j) => [p, 11 + j * 13, 9, 6])].forEach(([poi, dx, lift, rad], i) => {
        const base = P(node.x, node.y, 0);
        const isEnd = endOf(poi);
        const g = el("g", { class: "poi" + (r && !isEnd ? " dim" : "") + (dx ? " fac" : ""), "data-poi": poi.id, tabindex: 0, role: "button", "aria-label": L(poi.label) }, gPoi);
        const [glyph, color] = ICON[poi.type] || ["•", "#455a64"];
        if (i === 0 || dx) el("line", { x1: base[0], y1: base[1], x2: base[0] + dx, y2: base[1] - lift + rad - 1, stroke: color, "stroke-width": dx ? 1 : 1.5 }, g);
        el("circle", { cx: base[0], cy: base[1], r: 2.2, fill: color }, g);
        el("circle", { class: "pin", cx: base[0] + dx, cy: base[1] - lift, r: rad, fill: isEnd ? "#ff6a13" : color }, g);
        el("text", { x: base[0] + dx, y: base[1] - lift + rad * 0.37, "text-anchor": "middle", "font-size": (glyph.length > 2 ? 6.5 : 8) * rad / 8 }, g).textContent = glyph;
        if (isEnd) {
          el("text", { x: base[0] + dx + rad + 3, y: base[1] - lift + 3, class: "lbl" }, g).textContent = L(poi.label);
        }
        const title = el("title", {}, g); title.textContent = L(poi.label);
        g.addEventListener("keydown", (e) => { if (e.key === "Enter") pickPoi(poi.id); });
      });
    }

    // You are here
    const herePoi = site.pois.find((p) => p.id === state.here);
    cone = null;
    if (herePoi && site.nodes[herePoi.node]) {
      coneAt = site.nodes[herePoi.node];
      const p = P(coneAt.x, coneAt.y, 0);
      cone = el("path", { d: "M0,0 L24,-10 A26,26 0 0 1 24,10 Z", class: "here-cone", visibility: "hidden" }, gTop);
      updateCone();
      el("circle", { cx: p[0], cy: p[1], r: 9, class: "here-pulse" }, gTop);
      el("circle", { cx: p[0], cy: p[1], r: 5, fill: "#1e88e5", stroke: "#fff", "stroke-width": 2 }, gTop);
      el("text", { x: p[0], y: p[1] + 18, class: "lbl", "text-anchor": "middle", fill: "#1e5fa8" }, gTop).textContent = t("youAreHere");
    }

    // destination ripple, current step marker, turn badge, walker
    if (state.route && state.route.steps.length) {
      const r = state.route;
      const goal = site.nodes[r.path[r.path.length - 1]];
      const gp = P(goal.x, goal.y, 0);
      for (const delay of [0, 0.9]) el("circle", { cx: gp[0], cy: gp[1], r: 6, class: "ripple", style: `animation-delay:${delay}s` }, gTop);
      if (r.tour) r.steps.forEach((s, i) => {
        if (s.kind !== "arrive") return;
        const n = site.nodes[s.node], q = P(n.x, n.y, 0), passed = i < state.step;
        const g = el("g", { class: "stop-num" + (passed ? " passed" : ""), transform: `translate(${(q[0] - 10).toFixed(1)},${(q[1] + 9).toFixed(1)})` }, gTop);
        el("circle", { r: 6 }, g);
        el("text", { y: 2.6, "text-anchor": "middle" }, g).textContent = passed ? "✓" : String(s.stop);
      });

      const st = r.steps[state.step];
      const n = site.nodes[st.node];
      const p = P(n.x, n.y, 0);
      el("circle", { cx: p[0], cy: p[1], r: 6.5, fill: "#fff", stroke: "#ff6a13", "stroke-width": 3 }, gTop);
      if (st.kind !== "start") {
        const badge = el("g", { transform: `translate(${p[0].toFixed(1)},${(p[1] - 22).toFixed(1)})` }, gTop);
        const pop = el("g", { class: fresh ? "badge pop" : "badge" }, badge);
        el("path", { d: "M-11,-11 h22 v20 h-7 l-4,5 l-4,-5 h-7 z", class: "badge-bg" }, pop);
        const icon = el("g", { transform: "translate(-7.5,-8.5) scale(.62)", class: "badge-icon " + st.kind }, pop);
        for (const d of MAN[st.kind]) el("path", { d }, icon);
      }
      // a little walking person, with an arrow at the feet for the direction
      walker = el("g", { class: "walker" }, gTop);
      el("ellipse", { rx: 4.2, ry: 1.7, class: "walker-shadow" }, walker);
      walkerArrow = el("path", { d: "M5,-2.4 L9.5,0 L5,2.4 Z", class: "walker-dir" }, walker);
      walkerBody = el("g", { class: "walker-body" }, walker);
      el("line", { x1: 0, y1: -5, x2: -1.6, y2: 0, class: "leg l1" }, walkerBody);
      el("line", { x1: 0, y1: -5, x2: 1.6, y2: 0, class: "leg l2" }, walkerBody);
      el("line", { x1: 0, y1: -5.2, x2: 0, y2: -10, class: "torso" }, walkerBody);
      el("circle", { cx: 0, cy: -12.4, r: 2.3, class: "head" }, walkerBody);
      startWalker();
    } else {
      walker = null;
    }
    startBus();
  }

  // convex hull of screen points (for building shadows)
  function hull(points) {
    const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  // the building the destination is at (its door point within 10 m)
  function destinationBuilding() {
    const r = state.route, site = state.site;
    if (!r || r.error) return null;
    const n = site.nodes[r.path[r.path.length - 1]];
    const b = (site.buildings || []).find((b) => n && inRect(n.x, n.y, b, 10) && b.w > 12);
    return b ? b.id : null;
  }

  /* shuttle bus driving between the gate and the bus stop */
  let busLayer = null, busRAF = 0;
  function startBus() {
    cancelAnimationFrame(busRAF);
    const site = state.site;
    const gate = (site.pois || []).find((p) => p.type === "gate"), stop = (site.pois || []).find((p) => p.type === "bus");
    if (!busLayer || !gate || !stop || reduceMotion() || state.anim || state.emergency || VIEW.t < 0.02) return;
    if (!site._busPath) site._busPath = shortestPath(site, gate.node, stop.node) || [];
    const nodes = site._busPath.map((id) => site.nodes[id]);
    if (nodes.length < 2) return;
    const segs = [];
    let total = 0;
    for (let i = 1; i < nodes.length; i++) { const l = dist(nodes[i - 1], nodes[i]); segs.push([nodes[i - 1], nodes[i], l]); total += l; }
    const drive = (total / 6) * 1000, cycle = drive * 2 + 10000, t0 = performance.now() - drive * 0.4;
    const layer = busLayer;
    const tick = (now) => {
      if (busLayer !== layer) return;
      const k = (now - t0) % cycle;
      // there (drive) · wait 4 s · back (drive) · wait 6 s
      let f = k < drive ? k / drive : k < drive + 4000 ? 1 : k < drive * 2 + 4000 ? 1 - (k - drive - 4000) / drive : 0;
      f = f * f * (3 - 2 * f); // ease in and out
      let d = f * total, pos = nodes[0], dir = [1, 0];
      for (const [a, b, l] of segs) {
        if (d <= l || b === nodes[nodes.length - 1]) { const q = Math.min(1, d / (l || 1)); pos = { x: a.x + (b.x - a.x) * q, y: a.y + (b.y - a.y) * q }; dir = [(b.x - a.x) / (l || 1), (b.y - a.y) / (l || 1)]; break; }
        d -= l;
      }
      const [ux, uy] = dir, nx = -uy, ny = ux, hl = 4.5, hw = 1.3;
      // corners clockwise (y down): back-left, front-left, front-right, back-right
      const c = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([a, b]) => [pos.x + ux * a + nx * b, pos.y + uy * a + ny * b]);
      const cw = (c[1][0] - c[0][0]) * (c[2][1] - c[0][1]) - (c[1][1] - c[0][1]) * (c[2][0] - c[0][0]) > 0 ? c : c.reverse();
      layer.innerHTML = "";
      drawPrism(layer, cw, 0.3, 2.8, "#1565c0", { thin: true, roof: 1.45, night: isNight() });
      busRAF = requestAnimationFrame(tick);
    };
    busRAF = requestAnimationFrame(tick);
  }

  /* path indexes of the current leg (step 0 shows the whole route) */
  function legRange() {
    const r = state.route, st = r.steps[state.step];
    return st.kind === "start" ? [0, r.path.length - 1] : st.seg;
  }

  /* small arrows along the leg, pointing the way to walk */
  function chevrons(g, ids) {
    const N = state.site.nodes;
    let k = 0;
    for (let i = 1; i < ids.length; i++) {
      const a = N[ids[i - 1]], b = N[ids[i]], len = dist(a, b);
      const pa = P(a.x, a.y), pb = P(b.x, b.y);
      const ang = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) * 180 / Math.PI;
      for (let d = 7; d < len - 3; d += 14) {
        const f = d / len;
        const x = pa[0] + (pb[0] - pa[0]) * f, y = pa[1] + (pb[1] - pa[1]) * f;
        el("path", { d: "M-2.2,-2.6 L1.4,0 L-2.2,2.6", class: "chev", transform: `translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${ang.toFixed(1)})`, style: `animation-delay:${(k++ * 0.12).toFixed(2)}s` }, g);
      }
    }
  }

  /* walker that travels along the current leg, facing the way to go */
  let walker = null, walkerArrow = null, walkerBody = null, walkerRAF = 0, walkerT0 = 0;
  function startWalker() {
    cancelAnimationFrame(walkerRAF);
    if (!walker) return;
    const site = state.site, [s0, s1] = legRange(), path = state.route.path.slice(s0, s1 + 1);
    const segs = [];
    let total = 0;
    for (let i = 1; i < path.length; i++) {
      const a = site.nodes[path[i - 1]], b = site.nodes[path[i]];
      const len = dist(a, b);
      const pa = P(a.x, a.y), pb = P(b.x, b.y);
      segs.push([a, b, len, Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) * 180 / Math.PI]); total += len;
    }
    const place = (d) => {
      for (const [a, b, len, ang] of segs) {
        if (d <= len) {
          const f = len ? d / len : 0;
          const p = P(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, 0);
          // the person stays upright and faces left or right; the arrow at the feet shows the way
          walker.setAttribute("transform", `translate(${p[0].toFixed(2)},${p[1].toFixed(2)})`);
          walkerArrow.setAttribute("transform", `rotate(${ang.toFixed(1)})`);
          walkerBody.setAttribute("transform", Math.cos((ang * Math.PI) / 180) < 0 ? "scale(-1,1)" : "");
          return;
        }
        d -= len;
      }
    };
    if (!segs.length) return;
    if (reduceMotion()) { place(total); return; }
    // walk the leg, pause briefly at the end, repeat
    const walkMs = Math.max(1800, total * 28), dur = walkMs + 700;
    walkerT0 = performance.now();
    const tick = (now) => {
      if (!walker) return;
      place(Math.min(1, ((now - walkerT0) % dur) / walkMs) * total);
      walkerRAF = requestAnimationFrame(tick);
    };
    walkerRAF = requestAnimationFrame(tick);
  }

  /* =================================================================
     CAMERA (smooth fly-to between views)
     ================================================================= */
  let camRAF = 0;
  function flyTo(target, ms = 750) {
    cancelAnimationFrame(camRAF);
    if (reduceMotion() || !state.vb) { state.vb = { ...target }; setViewBox(); return; }
    const from = { ...state.vb }, t0 = performance.now();
    const fc = [from.x + from.w / 2, from.y + from.h / 2], tc = [target.x + target.w / 2, target.y + target.h / 2];
    // pull out a little on long moves so the eye can follow
    const bump = Math.min(0.45, Math.hypot(tc[0] - fc[0], tc[1] - fc[1]) / Math.max(from.w, target.w) * 0.7);
    const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms), e = ease(k), lift = 1 + bump * Math.sin(Math.PI * e);
      const w = (from.w + (target.w - from.w) * e) * lift, h = (from.h + (target.h - from.h) * e) * lift;
      const cx = fc[0] + (tc[0] - fc[0]) * e, cy = fc[1] + (tc[1] - fc[1]) * e;
      state.vb = { x: cx - w / 2, y: cy - h / 2, w, h };
      setViewBox();
      if (k < 1) camRAF = requestAnimationFrame(tick);
    };
    camRAF = requestAnimationFrame(tick);
  }

  /* Turn and/or tilt the map smoothly: { ang, tilt }. Each frame redraws the map
     in a light version (no trees, windows…) so it stays smooth on slow phones. */
  let viewRAF = 0;
  const easeIO = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const viewTarget = () => (state.route && !state.route.error && state.route.path.length > 1 ? stepView() : { ...state.baseVb });
  function animateView(to, ms = 550) {
    cancelAnimationFrame(viewRAF); cancelAnimationFrame(camRAF);
    const from = { ang: state.ang, tilt: state.tilt };
    const target = { ang: to.ang ?? from.ang, tilt: to.tilt ?? from.tilt };
    const frame = (e) => {
      state.ang = from.ang + (target.ang - from.ang) * e;
      state.tilt = from.tilt + (target.tilt - from.tilt) * e;
      state.baseVb = computeBounds(state.site);
      state.vb = viewTarget(); setViewBox(); renderMap(); updateCompass();
    };
    const finish = () => {
      state.anim = false;
      frame(1);
      state.ang = ((Math.round(state.ang * 10) / 10) % 360 + 360) % 360;
      store.set("ang", String(state.ang));
      updateCompass();
    };
    if (reduceMotion() || !state.site.buildings) return finish();
    const t0 = performance.now();
    state.anim = true;
    const tick = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      if (k < 1) { frame(easeIO(k)); viewRAF = requestAnimationFrame(tick); } else finish();
    };
    viewRAF = requestAnimationFrame(tick);
  }

  // follow mode: turn the map so the current leg points up the screen
  function aimCamera() {
    const r = state.route;
    if (!state.follow || !r || r.error || r.path.length < 2) { flyTo(stepView()); return; }
    const [s0, s1] = legRange(), a = state.site.nodes[r.path[s0]], b = state.site.nodes[r.path[s1]];
    if (!a || !b || (a.x === b.x && a.y === b.y)) { flyTo(stepView()); return; }
    const want = -90 - (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI - 45 * state.tilt;
    animateView({ ang: state.ang + ((((want - state.ang) % 360) + 540) % 360) - 180 }, 700);
  }
  function setFollow(on) {
    state.follow = !!on;
    store.set("follow", on ? "1" : "0");
    $("followBtn").setAttribute("aria-pressed", String(state.follow));
  }

  // the N needle points to where north is on screen
  function updateCompass() {
    if (!state.site || !state.site.buildings) return;
    const a = P(VIEW.cx, VIEW.cy), b = P(VIEW.cx, VIEW.cy - 10);
    const deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 90;
    $("northNeedle").style.transform = `rotate(${deg.toFixed(1)}deg)`;
  }
  function renderDayBtn() {
    $("dayBtn").textContent = { auto: "🌗", day: "☀️", night: "🌙" }[state.dayMode];
    $("dayBtn").title = t("day_" + state.dayMode);
    $("dayBtn").setAttribute("aria-label", t("day_" + state.dayMode));
  }

  /* tap on the map: a place starts / ends a route, a building shows its card */
  function handleTap(target) {
    const poiG = target.closest && target.closest("[data-poi]");
    if (poiG) { pickPoi(poiG.dataset.poi); return; }
    const bg = target.closest && target.closest("[data-b]");
    const id = bg ? bg.dataset.b : null;
    if (!id && !state.selB) return;
    state.selB = id === state.selB ? null : id;
    renderMap(); renderBldCard();
  }

  function renderBldCard() {
    const card = $("bldCard"), site = state.site, b = site && (site.buildings || []).find((x) => x.id === state.selB);
    card.hidden = !b;
    if (!b) return;
    card.querySelector("strong").textContent = L(b.label);
    const list = card.querySelector(".bc-list");
    list.innerHTML = "";
    const here = (site.pois || []).filter((p) => { const n = site.nodes[p.node]; return n && inRect(n.x, n.y, b, 10); });
    for (const p of here) {
      const btn = document.createElement("button");
      btn.innerHTML = `<span aria-hidden="true">${(ICON[p.type] || ["•"])[0]}</span> `;
      btn.append(L(p.label) + (p.restricted ? " ⛔" : ""));
      btn.onclick = () => goTo(p.id);
      list.appendChild(btn);
    }
    if (!here.length) { const em = document.createElement("small"); em.textContent = t("noPlacesHere"); list.appendChild(em); }
  }
  $("bldCard").querySelector(".bc-close").onclick = () => { state.selB = null; renderMap(); renderBldCard(); };

  // route to a place from wherever the person is (or ask where they are)
  function goTo(id) {
    state.selB = null; renderBldCard();
    $("toSel").value = id;
    const from = currentPosition();
    if (from) { if (!from.id.startsWith("_")) $("fromSel").value = from.id; showRoute({ fromPoi: from }); return; }
    renderMap(); setSearchMode("from"); $("searchBox").focus();
  }

  /* =================================================================
     PAN & ZOOM (mouse, wheel, touch pinch)
     ================================================================= */
  const pointers = new Map();
  let pinchStart = null;

  function clientToSvg(cx, cy) {
    const r = svg.getBoundingClientRect();
    const v = state.vb;
    // preserveAspectRatio xMidYMid meet
    const scale = Math.min(r.width / v.w, r.height / v.h);
    const ox = (r.width - v.w * scale) / 2, oy = (r.height - v.h * scale) / 2;
    return [v.x + (cx - r.left - ox) / scale, v.y + (cy - r.top - oy) / scale, scale];
  }

  function zoomAt(factor, cx, cy) {
    const v = state.vb, b = state.baseVb;
    const nw = Math.min(b.w * 1.4, Math.max(b.w / 6, v.w / factor));
    const f = v.w / nw;
    const [sx, sy] = cx === undefined ? [v.x + v.w / 2, v.y + v.h / 2] : clientToSvg(cx, cy);
    v.x = sx - (sx - v.x) / f; v.y = sy - (sy - v.y) / f;
    v.w = nw; v.h = v.h / f;
    setViewBox();
  }

  // the user takes over the camera: stop any fly-to and auto-play
  const takeOver = () => { cancelAnimationFrame(camRAF); setPlaying(false); };
  svg.addEventListener("wheel", (e) => { e.preventDefault(); takeOver(); zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });
  let tap = null; // a tap = press and release without dragging
  svg.addEventListener("pointerdown", (e) => {
    takeOver();
    tap = pointers.size ? null : { x: e.clientX, y: e.clientY, target: e.target };
    svg.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    svg.classList.add("dragging");
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), w: state.vb.w };
    }
  });
  svg.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 6) tap = null;
    if (pointers.size === 1) {
      const [, , scale] = clientToSvg(e.clientX, e.clientY);
      state.vb.x -= (e.clientX - prev[0]) / scale;
      state.vb.y -= (e.clientY - prev[1]) / scale;
      setViewBox();
    } else if (pointers.size === 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const targetW = pinchStart.w * (pinchStart.d / d);
      zoomAt(state.vb.w / targetW, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    }
  });
  const endPointer = (e) => {
    if (tap && e.type === "pointerup" && pointers.size === 1) handleTap(tap.target);
    tap = null;
    pointers.delete(e.pointerId); if (pointers.size < 2) pinchStart = null; if (!pointers.size) svg.classList.remove("dragging"); };
  svg.addEventListener("pointerup", endPointer);
  svg.addEventListener("pointercancel", endPointer);

  $("zoomIn").onclick = () => { takeOver(); zoomAt(1.3); };
  $("zoomOut").onclick = () => { takeOver(); zoomAt(1 / 1.3); };
  $("zoomReset").onclick = () => { setPlaying(false); flyTo(state.baseVb); };

  /* =================================================================
     UI
     ================================================================= */
  function applyStaticText() {
    document.documentElement.lang = state.lang === "zh" ? "zh" : state.lang;
    document.querySelectorAll("[data-i18n]").forEach((n) => { n.textContent = t(n.dataset.i18n); });
    document.querySelectorAll(".lang button").forEach((b) => b.classList.toggle("on", b.dataset.lang === state.lang));
    $("viewToggle").textContent = state.view === "iso" ? t("view2d") : t("view3d");
    document.title = t("appTitle") + " · " + L(state.site ? state.site.short : "");
  }

  function fillSiteSelect() {
    const s = $("siteSelect");
    s.innerHTML = "";
    SITES.forEach((site) => {
      const o = document.createElement("option");
      o.value = site.id; o.textContent = L(site.name);
      s.appendChild(o);
    });
    s.value = state.site.id;
  }

  function fillPoiSelects() {
    const site = state.site;
    for (const id of ["fromSel", "toSel"]) {
      const s = $(id), keep = s.value;
      s.innerHTML = "";
      const blank = document.createElement("option");
      blank.value = ""; blank.textContent = "—";
      s.appendChild(blank);
      (site.pois || []).forEach((p) => {
        const o = document.createElement("option");
        o.value = p.id; o.textContent = L(p.label) + (p.restricted ? " ⛔" : "");
        s.appendChild(o);
      });
      if ([...s.options].some((o) => o.value === keep)) s.value = keep;
    }
  }

  function fillPopular() {
    const box = $("popular");
    box.innerHTML = "";
    const site = state.site;
    const get = (id) => site.pois.find((p) => p.id === id);
    (site.popular || []).forEach(([a, b]) => {
      const A = get(a), B = get(b);
      if (!A || !B) return;
      const btn = document.createElement("button");
      btn.textContent = `${L(A.label)} → ${L(B.label)}`;
      btn.onclick = () => { $("fromSel").value = a; $("toSel").value = b; showRoute(); };
      box.appendChild(btn);
    });
    $("popularWrap").hidden = !box.children.length;
  }

  function fillInfo() {
    const s = state.site;
    const dl = $("infoList");
    dl.innerHTML = "";
    const add = (k, v) => { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.append(v); dl.append(dt, dd); };
    add(t("address"), s.address || "—");
    if (s.phone) { const a = document.createElement("a"); a.href = "tel:" + s.phone.replace(/\s/g, ""); a.textContent = s.phone; add(t("phone"), a); }
    if (s.waze) { const a = document.createElement("a"); a.href = s.waze; a.target = "_blank"; a.rel = "noopener"; a.textContent = t("navigate") + " ↗"; add("Waze", a); }
    const inv = document.createElement("a"); inv.href = "invite.html?site=" + encodeURIComponent(s.id); inv.textContent = t("inviteVisitor") + " →"; add(t("visitors"), inv);
  }

  function renderLegend() {
    const lg = $("legend");
    lg.hidden = !state.safety;
    if (!state.safety) return;
    lg.innerHTML = [
      ["#2e9d4a", "⇥", "legendExit"], ["#c62d2d", "F", "legendExt"], ["#d81b60", "♥", "legendAed"],
      ["#0288d1", "👁", "legendEye"], ["#2e9d4a", "AP", "legendAssembly"], ["#c62d2d", "⛔", "legendRestricted"],
      ["#3f9c8f", "☔", "legendCovered"], ["#5a6b78", "≡", "legendStairs"]
    ].map(([c, g, k]) => `<span><i style="background:${c}">${g}</i>${t(k)}</span>`).join("");
  }

  const stepDist = (st) => (st.dist ? `${Math.max(5, Math.round(st.dist / 5) * 5)} ${t("m")}` : "");

  /* dir: "next" | "prev" slides the card in from that side (no slide on re-render) */
  function renderSteps(dir) {
    const r = state.route;
    const box = $("steps"), sum = $("routeSummary");
    document.body.classList.toggle("navigating", !!(r && !r.error));
    if (!r) { box.hidden = true; sum.hidden = true; return; }
    if (r.error) {
      sum.hidden = false; box.hidden = true;
      sum.textContent = r.error;
      return;
    }
    sum.hidden = false;
    const mins = Math.max(1, Math.round(r.dist / WALK_SPEED / 60));
    // what the walk is like: share under cover, any stairs
    const site = state.site;
    let coveredM = 0, stairs = false;
    for (let i = 1; i < r.path.length; i++) {
      const tags = edgeTags(site, r.path[i - 1], r.path[i]);
      if (tags.includes("covered")) coveredM += dist(site.nodes[r.path[i - 1]], site.nodes[r.path[i]]);
      if (tags.includes("stairs")) stairs = true;
    }
    const pct = Math.round((coveredM / r.dist) * 100);
    const badges = [
      pct ? `<i class="tag covered">☔ ${t("coveredShare", { p: pct })}</i>` : "",
      `<i class="tag ${stairs ? "stairs" : "flat"}">${stairs ? "🪜 " + t("hasStairs") : "♿ " + t("stepFreeOk")}</i>`
    ].join("");
    sum.innerHTML = (r.tour ? `<strong class="tour-name">🧭 ${L(r.tour.label)}</strong>` : "") +
      `<b>${mins}</b> <span>${t("min")} · ~${Math.round(r.dist / 5) * 5} ${t("m")}</span><span class="tags">${badges}</span>` +
      `<button type="button" class="share-btn" aria-label="${t("share")}" title="${t("share")}">↗</button>` +
      (r.notice ? `<small class="notice">${r.notice}</small>` : "");
    box.hidden = false;
    const st = r.steps[state.step];
    $("stepCount").textContent = state.lang === "zh" ? `${t("step")} ${state.step + 1} ${t("of")} ${r.steps.length} 步` : `${t("step")} ${state.step + 1} ${t("of")} ${r.steps.length}`;
    $("stepDist").textContent = stepDist(st);
    $("stepDist").hidden = !st.dist;
    $("stepIcon").className = "m-icon " + st.kind;
    $("stepIcon").innerHTML = manSvg(st.kind);
    $("stepText").textContent = st.text;
    $("stepBar").style.width = ((state.step + 1) / r.steps.length) * 100 + "%";
    const warnBits = [];
    if (st.kind !== "start") {
      const leg = r.path.slice(st.seg[0], st.seg[1] + 1);
      for (let i = 1; i < leg.length; i++) {
        const tags = edgeTags(site, leg[i - 1], leg[i]);
        if (tags.includes("stairs") && !warnBits.includes(t("stairsAhead"))) warnBits.push(t("stairsAhead"));
        if (tags.includes("restricted") && !warnBits.includes(t("restrictedAhead"))) warnBits.push(t("restrictedAhead"));
      }
    }
    if (st.kind === "arrive" && st.note) warnBits.push(st.note);
    if (st.kind === "arrive" && st.restricted) warnBits.push(t("restrictedWarn"));
    $("stepWarn").hidden = !warnBits.length;
    $("stepWarn").textContent = warnBits.join(" ");
    $("prevStep").disabled = state.step === 0;
    $("nextStep").disabled = state.step === r.steps.length - 1;
    renderPhoto(state.site, st);
    renderStepList();

    if (dir) {
      const card = box.querySelector(".step-card");
      card.classList.remove("enter-next", "enter-prev");
      void card.offsetWidth; // restart the slide animation
      card.classList.add("enter-" + dir);
      speak([st.text, ...warnBits].join(" "));
    }
  }

  function renderStepList() {
    const r = state.route, ol = $("stepList");
    ol.innerHTML = "";
    r.steps.forEach((st, i) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      if (i === state.step) b.setAttribute("aria-current", "step");
      if (i < state.step) b.classList.add("done");
      const ic = document.createElement("span");
      ic.className = "mini " + st.kind;
      ic.innerHTML = manSvg(st.kind);
      const tx = document.createElement("span");
      tx.className = "txt";
      tx.textContent = st.text;
      const d = document.createElement("span");
      d.className = "d";
      d.textContent = stepDist(st);
      b.append(ic, tx, d);
      b.onclick = () => { setPlaying(false); goStep(i); };
      li.appendChild(b);
      ol.appendChild(li);
    });
  }

  /* move to step i: animate the map, slide the card, fly the camera */
  function goStep(i) {
    const r = state.route;
    if (!r || r.error) return;
    i = Math.max(0, Math.min(r.steps.length - 1, i));
    if (i === state.step) return;
    const dir = i > state.step ? "next" : "prev";
    state.step = i;
    state.fresh = true;
    renderMap(); renderSteps(dir);
    aimCamera();
  }

  /* ---------- auto-play ("walk me through") ---------- */
  let playTimer = 0;
  state.playing = false;
  function setPlaying(on) {
    clearTimeout(playTimer);
    state.playing = !!on;
    renderPlayBtn();
    if (on) playTimer = setTimeout(playTick, state.step === 0 ? 2600 : 3600);
  }
  function renderPlayBtn() {
    const btn = $("playBtn"), on = state.playing;
    btn.textContent = on ? "❚❚" : "▶";
    btn.setAttribute("aria-label", t(on ? "pause" : "play"));
    btn.title = t(on ? "pause" : "play");
    btn.setAttribute("aria-pressed", String(on));
  }
  function playTick() {
    const r = state.route;
    if (!state.playing || !r || r.error || state.step >= r.steps.length - 1) { setPlaying(false); return; }
    goStep(state.step + 1);
    setPlaying(state.step < r.steps.length - 1);
  }
  $("playBtn").onclick = () => {
    const r = state.route;
    if (!r || r.error) return;
    if (state.playing) { setPlaying(false); return; }
    if (state.step >= r.steps.length - 1) goStep(0);
    setPlaying(true);
  };

  /* ---------- spoken directions (free, built into the phone) ---------- */
  const canSpeak = "speechSynthesis" in window;
  state.voice = canSpeak && store.get("voice") === "1";
  function speak(text) {
    if (!state.voice || !canSpeak) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = { en: "en-GB", ms: "ms-MY", zh: "zh-CN" }[state.lang] || "en-GB";
    const v = speechSynthesis.getVoices().find((x) => x.lang.replace("_", "-").toLowerCase().startsWith(u.lang.slice(0, 2)));
    if (v) u.voice = v;
    u.rate = 0.95;
    speechSynthesis.speak(u);
  }
  function renderVoiceBtn() {
    const btn = $("voiceBtn");
    btn.hidden = !canSpeak;
    btn.textContent = state.voice ? "🔊" : "🔇";
    btn.setAttribute("aria-pressed", String(state.voice));
    btn.setAttribute("aria-label", t(state.voice ? "voiceOn" : "voiceOff"));
    btn.title = t(state.voice ? "voiceOn" : "voiceOff");
  }
  $("voiceBtn").onclick = () => {
    state.voice = !state.voice;
    store.set("voice", state.voice ? "1" : "0");
    renderVoiceBtn();
    if (state.voice && state.route && !state.route.error) speak($("stepText").textContent);
    else if (canSpeak) speechSynthesis.cancel();
  };

  function updateUrl() {
    const p = new URLSearchParams();
    p.set("site", state.site.id);
    if (state.here) p.set("here", state.here);
    const r = state.route;
    if (r && !r.error && r.tour) p.set("tour", r.tour.id);
    else if (r && !r.error) { if (!r.fromPoi.id.startsWith("_")) p.set("from", r.fromPoi.id); p.set("to", r.toPoi.id); }
    if (state.emergency) p.set(state.emergency.drill ? "drill" : "emergency", "1");
    try { history.replaceState(null, "", "?" + p.toString()); } catch { /* file:// or sandbox */ }
  }

  /* step: keep this step (language change); quiet: no scroll, no voice, no slide */
  /* opts: route options for this route (emergency uses its own)
     fromPoi / toPoi: use these instead of the two lists (e.g. "your position" mid-route) */
  function showRoute({ step = 0, quiet = false, opts = state.opts, fromPoi, toPoi } = {}) {
    const site = state.site;
    const from = fromPoi || site.pois.find((p) => p.id === $("fromSel").value);
    const to = toPoi || site.pois.find((p) => p.id === $("toSel").value);
    if (!from || !to) return;
    if (from.node === to.node) {
      state.route = { error: t("same"), fromPoi: from, toPoi: to, path: [], steps: [] };
    } else {
      let path = shortestPath(site, from.node, to.node, opts), notice = "";
      // nothing fits the options: show the plain shortest route and say so
      if (!path && (opts.covered || opts.stepFree || opts.noRestricted)) {
        path = shortestPath(site, from.node, to.node);
        if (path) notice = t("fallbackRoute");
      }
      if (!path) state.route = { error: t("noRoute"), fromPoi: from, toPoi: to, path: [], steps: [] };
      else state.route = { fromPoi: from, toPoi: to, path, notice, opts, dist: pathLength(site, path), steps: buildSteps(site, path, from, to) };
    }
    state.step = Math.min(step, Math.max(0, state.route.steps.length - 1));
    if (!quiet) { setPlaying(false); state.fresh = true; }
    if (state.route.path.length > 1) aimCamera();
    renderMap(); renderSteps(quiet ? undefined : "next"); updateUrl();
    if (!quiet && window.innerWidth < 900) scrollToSteps();
  }

  /* Phone: scroll so the pinned map sits at the top with the step card right under it. */
  function scrollToSteps() {
    requestAnimationFrame(() => {
      const target = $("panel").getBoundingClientRect().top + window.scrollY - document.querySelector(".mapwrap").offsetHeight;
      window.scrollTo({ top: Math.max(0, target), behavior: reduceMotion() ? "auto" : "smooth" });
    });
  }

  /* Camera view for the current step: whole route at the start, then each leg up close. */
  function stepView() {
    const r = state.route, site = state.site;
    const [s0, s1] = legRange();
    const overview = s0 === 0 && s1 === r.path.length - 1;
    const ps = r.path.slice(s0, s1 + 1).map((id) => P(site.nodes[id].x, site.nodes[id].y, 0));
    return fitPoints(ps, overview ? 0.6 : 0.5, overview ? 45 : 35);
  }

  /* View box that fits the points, keeping the map's aspect ratio (never closer than minFrac of the site). */
  function fitPoints(ps, minFrac, pad) {
    const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
    const b = state.baseVb;
    let w = Math.max(...xs) - Math.min(...xs) + pad * 2, h = Math.max(...ys) - Math.min(...ys) + pad * 2 + 30;
    const ar = b.w / b.h;
    if (w / h > ar) h = w / ar; else w = h * ar;
    if (w < b.w * minFrac) { w = b.w * minFrac; h = w / ar; }
    if (w > b.w) return { ...b };
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2 - 12;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  function clearRoute() {
    state.route = null; state.step = 0;
    setPlaying(false);
    if (canSpeak) speechSynthesis.cancel();
    cancelAnimationFrame(walkerRAF);
    $("toSel").value = "";
    flyTo(state.baseVb);
    renderMap(); renderSteps(); updateUrl();
    if (window.innerWidth < 900) window.scrollTo({ top: 0, behavior: reduceMotion() ? "auto" : "smooth" });
  }

  function pickPoi(id) {
    if (!$("fromSel").value) $("fromSel").value = id;
    else { $("toSel").value = id; showRoute(); }
  }

  /* Where the person is now: mid-route = the current step's point, else "You are here" / From. */
  function currentPosition() {
    const site = state.site, r = state.route;
    if (r && !r.error && r.steps.length && state.step > 0) {
      const id = r.steps[state.step].node, node = site.nodes[id];
      const poi = site.pois.find((p) => p.node === id);
      return poi || { id: "_pos", node: id, label: node.label || { en: t("yourPosition") } };
    }
    const fromId = $("fromSel").value || state.here;
    return site.pois.find((p) => p.id === fromId) || null;
  }

  function nearestAssembly() {
    const site = state.site;
    const aps = site.pois.filter((p) => p.type === "assembly");
    if (!aps.length) return;
    const from = currentPosition() || site.pois[0];
    // evacuation: fastest way out, only keeping step-free (never detour for shelter)
    const opts = { stepFree: state.opts.stepFree };
    let best = null;
    for (const ap of aps) {
      const path = shortestPath(site, from.node, ap.node, opts) || shortestPath(site, from.node, ap.node);
      if (!path) continue;
      const d = pathLength(site, path);
      if (!best || d < best.d) best = { ap, d };
    }
    if (!best) return;
    if (!from.id.startsWith("_")) $("fromSel").value = from.id;
    $("toSel").value = best.ap.id;
    state.safety = true; $("safetyToggle").setAttribute("aria-pressed", "true"); renderLegend();
    showRoute({ opts, fromPoi: from, toPoi: best.ap });
    renderEmergBar();
  }

  /* =================================================================
     EMERGENCY MODE (and practice drills)
     ================================================================= */
  let emergTimer = 0;
  const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };

  function startEmergency(drill = false) {
    const prevVoice = state.emergency ? state.emergency.prevVoice : state.voice;
    state.emergency = { drill, t0: Date.now(), done: false, prevVoice };
    document.body.classList.add("emerg-mode");
    document.body.classList.toggle("drill", drill);
    setPlaying(false);
    if (canSpeak) { state.voice = true; renderVoiceBtn(); } // spoken directions on, without saving the setting
    clearInterval(emergTimer);
    emergTimer = setInterval(renderEmergBar, 1000);
    renderSafetyNotes();
    renderEmergBar();
    window.scrollTo(0, 0);
    // don't know where they are yet: ask first (scan a poster or tap a place)
    if (!currentPosition()) { openScanner(); return; }
    nearestAssembly();
    updateUrl();
  }

  /* Safety wording: the chosen language plus Bahasa Malaysia and English (both expected on
     safety information in Malaysia), and whether EHS has checked this site's routes.
     A site can carry  ehs: { verified: "YYYY-MM-DD", erp: "ERP reference", ert: "ERT phone number" }. */
  const tIn = (lang, key, vars) => {
    let s = (I18N[lang] && I18N[lang][key]) || (I18N.en && I18N.en[key]) || key;
    if (vars) for (const k in vars) s = s.replace("{" + k + "}", vars[k]);
    return s;
  };
  function renderSafetyNotes() {
    const ehs = (state.site && state.site.ehs) || {};
    const check = (l) => (ehs.verified ? tIn(l, "ehsChecked", { d: ehs.verified }) : tIn(l, "ehsNotChecked"));
    const box = $("ebNote");
    box.innerHTML = "";
    [state.lang, ...["ms", "en"].filter((l) => l !== state.lang)].forEach((l, i) => {
      const p = document.createElement("p");
      p.lang = l;
      if (i) p.className = "other";
      p.textContent = tIn(l, "disclaimer") + " " + check(l);
      box.appendChild(p);
    });
    if (ehs.ert) {
      const a = document.createElement("a");
      a.href = "tel:" + ehs.ert.replace(/[^\d+]/g, "");
      a.textContent = `📞 ${t("ertPhone")}: ${ehs.ert}`;
      box.appendChild(a);
    }
    $("ehsLine").textContent = check(state.lang) + (ehs.erp ? ` · ${t("erpRef")} ${ehs.erp}` : "");
    $("ehsLine").classList.toggle("unchecked", !ehs.verified);
  }

  function renderEmergBar() {
    const em = state.emergency, bar = $("emergBar");
    bar.hidden = !em;
    if (!em) return;
    const r = state.route, ap = r && !r.error && r.toPoi.type === "assembly" ? L(r.toPoi.label) : "";
    $("ebTitle").textContent = t(em.drill ? "drillTitle" : "emergTitle");
    const timer = $("ebTimer");
    timer.hidden = !em.drill;
    if (em.done) {
      $("ebSub").textContent = em.drill ? t("drillDone", { t: mmss(em.t1 - em.t0), a: ap }) : t("safeMsg", { a: ap });
      timer.textContent = mmss(em.t1 - em.t0);
      $("ebSafe").textContent = em.drill ? t("shareResult") : "✓";
      $("ebSafe").hidden = !em.drill;
    } else {
      $("ebSub").textContent = ap ? t("emergSub", { a: ap }) : t("emergFind");
      timer.textContent = mmss(Date.now() - em.t0);
      $("ebSafe").textContent = t("imSafe");
      $("ebSafe").hidden = !ap;
    }
    document.body.style.setProperty("--eb-h", bar.offsetHeight + "px");
  }

  $("ebSafe").onclick = async () => {
    const em = state.emergency;
    if (!em) return;
    if (!em.done) {
      em.done = true; em.t1 = Date.now();
      clearInterval(emergTimer);
      renderEmergBar();
      if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
      speak($("ebSub").textContent);
      return;
    }
    // drill finished: share the result (the person chooses where to send it)
    const text = `${t("drillTitle")} · ${L(state.site.short)} · ${$("ebSub").textContent}`;
    try { if (navigator.share) { await navigator.share({ text }); return; } } catch { return; }
    copyText(text);
  };

  function endEmergency() {
    const em = state.emergency;
    if (!em) return;
    clearInterval(emergTimer);
    state.voice = em.prevVoice; renderVoiceBtn();
    state.emergency = null;
    document.body.classList.remove("emerg-mode", "drill");
    renderEmergBar();
    clearRoute();
  }
  $("ebEnd").onclick = endEmergency;

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast(t("copied")); }
    catch { window.prompt(t("copyThis"), text); }
  }

  /* =================================================================
     TOURS: one route through several stops (e.g. Day 1 for new staff)
     ================================================================= */
  function showTour(tour, { step = 0, quiet = false } = {}) {
    const site = state.site, opts = state.opts;
    const pois = tour.stops.map((id) => site.pois.find((p) => p.id === id)).filter(Boolean);
    const total = pois.length - 1;
    let path = [], steps = [];
    for (let k = 1; k < pois.length; k++) {
      const a = pois[k - 1], b = pois[k];
      const off = path.length ? path.length - 1 : 0;
      const stopText = " " + t("tourStop", { n: k, total });
      if (a.node === b.node) { // next stop is at the same door
        if (!path.length) path.push(a.node);
        steps.push({ node: b.node, kind: "arrive", seg: [off, off], dist: 0, poi: b, stop: k, text: t("arrive", { a: L(b.label) }) + stopText, note: b.note ? L(b.note) : "", restricted: !!b.restricted });
        continue;
      }
      const leg = shortestPath(site, a.node, b.node, opts) || shortestPath(site, a.node, b.node);
      if (!leg) { state.route = { error: t("noRoute"), fromPoi: pois[0], toPoi: b, path: [], steps: [] }; renderMap(); renderSteps(); return; }
      buildSteps(site, leg, a, b).forEach((s, i) => {
        if (i === 0 && steps.length) return; // the previous stop's arrival already starts this leg
        s.seg = [s.seg[0] + off, s.seg[1] + off];
        s.poi = s.kind === "start" ? a : s.kind === "arrive" ? b : undefined;
        if (s.kind === "arrive") { s.text += stopText; s.stop = k; }
        steps.push(s);
      });
      path.push(...(path.length ? leg.slice(1) : leg));
    }
    state.route = { fromPoi: pois[0], toPoi: pois[pois.length - 1], path, steps, opts, tour, dist: pathLength(site, path) };
    $("fromSel").value = pois[0].id; $("toSel").value = pois[pois.length - 1].id;
    state.step = Math.min(step, steps.length - 1);
    if (!quiet) { setPlaying(false); state.fresh = true; }
    if (path.length > 1) aimCamera();
    renderMap(); renderSteps(quiet ? undefined : "next"); updateUrl();
    if (!quiet && window.innerWidth < 900) scrollToSteps();
  }

  function fillTours() {
    const box = $("tours"), tours = state.site.tours || [];
    box.innerHTML = "";
    for (const tour of tours) {
      const b = document.createElement("button");
      b.textContent = "🧭 " + L(tour.label) + " · " + t("tourSummary", { n: tour.stops.length - 1 });
      b.onclick = () => showTour(tour);
      box.appendChild(b);
    }
    $("toursWrap").hidden = !tours.length;
  }

  /* re-run whatever is showing (after a language or option change) */
  function rerunRoute(quiet) {
    const r = state.route;
    if (!r || r.error) return;
    if (r.tour) showTour(r.tour, { step: quiet ? state.step : 0, quiet });
    else showRoute({ step: quiet ? state.step : 0, quiet, opts: quiet ? r.opts : state.opts, fromPoi: r.fromPoi.id.startsWith("_") ? r.fromPoi : undefined });
  }

  /* share the current route as a link */
  async function shareRoute() {
    const r = state.route;
    if (!r || r.error) return;
    const url = location.href.split("#")[0];
    const text = r.tour ? L(r.tour.label) : `${L(r.fromPoi.label)} → ${L(r.toPoi.label)}`;
    try { if (navigator.share) { await navigator.share({ title: t("appTitle"), text, url }); return; } } catch { return; }
    copyText(url);
  }

  function loadSite(id, keepRoute) {
    state.site = SITES.find((s) => s.id === id) || SITES[0];
    state.rise = true; state.selB = null; renderBldCard();
    const ready = !!state.site.buildings;
    $("todo").hidden = ready;
    $("demoBanner").hidden = state.site.status !== "demo";
    document.querySelector(".map-controls").style.display = ready ? "" : "none";
    $("panel").querySelectorAll(".finder, .route-form, #toursWrap, #popularWrap, .emergency").forEach((n) => (n.style.display = ready ? "" : "none"));
    if (!keepRoute) { state.route = null; state.step = 0; if (state.here && !state.site.pois?.some((p) => p.id === state.here)) state.here = null; }
    fillSiteSelect(); fillPoiSelects(); fillPopular(); fillTours(); fillNearby(); fillInfo(); applyStaticText(); renderLegend(); renderSafetyNotes();
    if (ready) {
      state.baseVb = computeBounds(state.site);
      state.vb = { ...state.baseVb };
      setViewBox();
      renderMap();
    } else {
      svg.innerHTML = "";
    }
    renderSteps();
    warmPhotos(state.site);
  }

  /* ---------- offline (service worker, only on http/https) ---------- */
  const canOffline = "serviceWorker" in navigator && /^https?:$/.test(location.protocol);
  if (canOffline) navigator.serviceWorker.register("sw.js").catch(() => { /* offline mode unavailable */ });

  // ask the service worker to download this site's photos while there is signal
  function warmPhotos(site) {
    if (!canOffline || !site.nodes) return;
    const urls = Object.entries(site.nodes).map(([id, n]) => n.photo || `photos/${site.id}/${id}.jpg`);
    navigator.serviceWorker.ready.then((reg) => reg.active && reg.active.postMessage({ type: "warm-photos", urls }));
  }

  /* =================================================================
     SMART SEARCH (all 3 languages, everyday words, small typos)
     ================================================================= */
  const SEARCH_WORDS = window.SEARCH_WORDS || {};
  const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  function lev(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0]; row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cur = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = cur;
      }
    }
    return row[b.length];
  }

  // every word a place can be found by: its names, its aliases, words for its type
  function poiTerms(poi) {
    if (poi._terms) return poi._terms;
    const bits = [];
    const add = (v) => { if (!v) return; if (typeof v === "string") bits.push(v); else if (Array.isArray(v)) v.forEach(add); else Object.values(v).forEach(add); };
    add(poi.label); add(poi.aliases); add(SEARCH_WORDS[poi.type]);
    const text = norm(bits.join(" "));
    return (poi._terms = { text, words: [...new Set(text.split(" "))] });
  }

  function scorePoi(poi, tokens) {
    const { text, words } = poiTerms(poi);
    let total = 0;
    for (const tk of tokens) {
      let best = 0;
      for (const w of words) {
        if (w === tk) best = Math.max(best, 100);
        else if (w.startsWith(tk)) best = Math.max(best, 80);
        else if (tk.length >= 4 && Math.abs(w.length - tk.length) <= 2 && lev(w, tk) <= (tk.length >= 7 ? 2 : 1)) best = Math.max(best, 45);
      }
      if (!best && text.includes(tk)) best = 60; // inside a word, and Chinese without spaces
      if (!best) return 0; // every word typed must match
      total += best;
    }
    if (norm(L(poi.label)).includes(tokens[0])) total += 10; // prefer names in the chosen language
    return total;
  }

  const search = { mode: "to", active: -1, items: [] };
  const recentKey = () => "recent_" + state.site.id;
  const getRecent = () => { try { return JSON.parse(store.get(recentKey()) || "[]"); } catch { return []; } };
  const addRecent = (id) => store.set(recentKey(), JSON.stringify([id, ...getRecent().filter((x) => x !== id)].slice(0, 5)));

  function setSearchMode(mode) {
    search.mode = mode;
    $("searchBox").placeholder = t(mode === "from" ? "searchFrom" : "searchTo");
    $("searchBox").setAttribute("aria-label", t(mode === "from" ? "searchFrom" : "searchTo"));
    $("searchHint").hidden = mode !== "from";
    $("searchHint").textContent = t("searchFromHint");
  }

  function renderResults() {
    const list = $("searchList"), box = $("searchBox"), site = state.site;
    const q = norm(box.value), pois = site.pois || [];
    let groups;
    if (!q) {
      const recent = search.mode === "to" ? getRecent().map((id) => pois.find((p) => p.id === id)).filter(Boolean) : [];
      const rest = [...pois].sort((a, b) => L(a.label).localeCompare(L(b.label)));
      groups = [[t("recent"), recent], [t("allPlaces"), rest]];
    } else {
      const tokens = q.split(" ");
      const hits = pois.map((p) => [p, scorePoi(p, tokens)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p]) => p);
      groups = [["", hits]];
    }
    list.innerHTML = "";
    search.items = [];
    for (const [title, items] of groups) {
      if (!items.length) continue;
      if (title) { const h = document.createElement("li"); h.className = "res-head"; h.setAttribute("role", "presentation"); h.textContent = title; list.appendChild(h); }
      for (const p of items) {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.id = "res-" + search.items.length;
        const [glyph, color] = ICON[p.type] || ["•", "#455a64"];
        const other = state.lang === "en" ? p.label.ms : p.label.en;
        li.innerHTML = `<span class="r-icon" style="background:${color}">${glyph}</span><span class="r-txt"><b></b><small></small></span>`;
        li.querySelector("b").textContent = L(p.label) + (p.restricted ? " ⛔" : "");
        li.querySelector("small").textContent = other && other !== L(p.label) ? other : "";
        li.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus so the list stays open
        li.addEventListener("click", () => pickResult(p));
        list.appendChild(li);
        search.items.push(p);
      }
    }
    if (!search.items.length) {
      const li = document.createElement("li"); li.className = "res-empty"; li.textContent = t("noResults"); list.appendChild(li);
    }
    search.active = q && search.items.length ? 0 : -1;
    markActive();
    list.hidden = false;
    box.setAttribute("aria-expanded", "true");
  }

  function markActive() {
    [...$("searchList").querySelectorAll("[role=option]")].forEach((li, i) => li.classList.toggle("active", i === search.active));
    $("searchBox").setAttribute("aria-activedescendant", search.active >= 0 ? "res-" + search.active : "");
  }

  function closeResults() {
    $("searchList").hidden = true;
    $("searchBox").setAttribute("aria-expanded", "false");
  }

  function pickResult(p) {
    const box = $("searchBox");
    box.value = "";
    if (search.mode === "from") {
      $("fromSel").value = p.id;
      setSearchMode("to");
      if (state.pendingNearest) { const type = state.pendingNearest; state.pendingNearest = null; closeResults(); box.blur(); goNearest(type); return; }
      if ($("toSel").value) { closeResults(); box.blur(); showRoute(); }
      else renderResults();
      return;
    }
    $("toSel").value = p.id;
    addRecent(p.id);
    if (!$("fromSel").value && state.here) $("fromSel").value = state.here;
    if ($("fromSel").value) { closeResults(); box.blur(); showRoute(); }
    else { setSearchMode("from"); renderResults(); } // ask where they are now
  }

  $("searchBox").addEventListener("focus", renderResults);
  $("searchBox").addEventListener("input", renderResults);
  $("searchBox").addEventListener("blur", () => setTimeout(closeResults, 150));
  $("searchBox").addEventListener("keydown", (e) => {
    const n = search.items.length;
    if (e.key === "ArrowDown" && n) { e.preventDefault(); search.active = (search.active + 1) % n; markActive(); }
    else if (e.key === "ArrowUp" && n) { e.preventDefault(); search.active = (search.active - 1 + n) % n; markActive(); }
    else if (e.key === "Enter" && search.active >= 0) { e.preventDefault(); pickResult(search.items[search.active]); }
    else if (e.key === "Escape") { closeResults(); $("searchBox").blur(); }
  });

  /* =================================================================
     NEAREST TOILET / WATER / … (from where the person is now)
     ================================================================= */
  function fillNearby() {
    const box = $("nearby"), pois = state.site.pois || [];
    box.innerHTML = "";
    for (const type of NEAREST) {
      if (!pois.some((p) => p.type === type)) continue;
      const b = document.createElement("button");
      b.type = "button";
      b.innerHTML = `<span aria-hidden="true">${ICON[type][0]}</span> `;
      const name = t("type_" + type);
      b.append(name.charAt(0).toUpperCase() + name.slice(1));
      b.title = t("nearestTo", { a: t("type_" + type) });
      b.onclick = () => goNearest(type);
      box.appendChild(b);
    }
    box.hidden = !box.children.length;
  }

  function goNearest(type) {
    const site = state.site, from = currentPosition();
    if (!from) { // ask where they are first, then continue
      state.pendingNearest = type;
      setSearchMode("from");
      $("searchBox").focus();
      return;
    }
    let best = null;
    for (const p of site.pois.filter((x) => x.type === type)) {
      const path = shortestPath(site, from.node, p.node, state.opts) || shortestPath(site, from.node, p.node);
      if (!path) continue;
      const d = pathLength(site, path);
      if (!best || d < best.d) best = { p, d };
    }
    if (!best) return;
    if (!from.id.startsWith("_")) $("fromSel").value = from.id;
    $("toSel").value = best.p.id;
    toast(t("nearestTo", { a: t("type_" + type) }) + ": " + L(best.p.label));
    showRoute({ fromPoi: from, toPoi: best.p });
  }

  /* =================================================================
     ROUTE OPTIONS (covered, step-free, avoid restricted)
     ================================================================= */
  const OPT_KEYS = { covered: "optCovered", stepFree: "optStepFree", noRestricted: "optNoRestricted" };
  function renderOpts() {
    document.querySelectorAll(".opt").forEach((b) => b.setAttribute("aria-pressed", String(!!state.opts[b.dataset.opt])));
  }
  document.querySelectorAll(".opt").forEach((b) => (b.onclick = () => {
    const k = b.dataset.opt;
    state.opts[k] = !state.opts[k];
    store.set(OPT_KEYS[k], state.opts[k] ? "1" : "0");
    renderOpts();
    if (!state.emergency) rerunRoute(false);
  }));

  /* =================================================================
     I'M LOST: scan a "You are here" QR poster with the camera
     ================================================================= */
  let scanStream = null, scanTimer = 0;
  const setScanMsg = (key) => { $("scanMsg").textContent = t(key); };

  function fillScanPick() {
    const box = $("scanPick");
    box.innerHTML = "";
    for (const p of state.site.pois || []) {
      const b = document.createElement("button");
      b.textContent = L(p.label);
      b.onclick = () => { closeScanner(); setHere(p.id); };
      box.appendChild(b);
    }
    box.hidden = false;
  }

  async function openScanner() {
    requestCompass(); // must happen inside the tap on iPhone
    $("scanner").hidden = false;
    $("scanPick").hidden = true;
    $("viewfinder").hidden = false;
    setScanMsg("scanHint");
    const fail = (key) => { setScanMsg(key); $("viewfinder").hidden = true; fillScanPick(); };
    if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) return fail("scanUnsupported");
    try {
      const formats = await BarcodeDetector.getSupportedFormats();
      if (!formats.includes("qr_code")) return fail("scanUnsupported");
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if ($("scanner").hidden) return closeScanner(); // closed while asking for the camera
      const video = $("scanVideo");
      video.srcObject = scanStream;
      await video.play();
      const loop = async () => {
        if (!scanStream) return;
        try {
          const codes = await detector.detect(video);
          if (codes.length && handleScan(codes[0].rawValue)) return;
        } catch { /* frame not ready */ }
        scanTimer = setTimeout(loop, 250);
      };
      loop();
    } catch {
      fail("cameraDenied");
    }
  }

  function closeScanner() {
    clearTimeout(scanTimer);
    if (scanStream) scanStream.getTracks().forEach((tr) => tr.stop());
    scanStream = null;
    $("scanVideo").srcObject = null;
    $("scanner").hidden = true;
  }

  // a poster QR is a link with ?site=…&here=…
  function handleScan(text) {
    let u;
    try { u = new URL(text, location.href); } catch { setScanMsg("scanNotGuide"); return false; }
    const here = u.searchParams.get("here"), siteId = u.searchParams.get("site") || state.site.id;
    const site = SITES.find((s) => s.id === siteId);
    if (!here || !site || !site.pois?.some((p) => p.id === here)) { setScanMsg("scanNotGuide"); return false; }
    if (navigator.vibrate) navigator.vibrate(40);
    closeScanner();
    setHere(here, siteId);
    return true;
  }

  // set "You are here"; if a destination is chosen, route again from here
  function setHere(id, siteId = state.site.id) {
    const keepTo = siteId === state.site.id ? $("toSel").value : "";
    if (siteId !== state.site.id) loadSite(siteId);
    state.here = id;
    $("fromSel").value = id;
    const poi = state.site.pois.find((p) => p.id === id);
    toast(t("hereSet", { a: L(poi.label) }));
    startCompass();
    if (state.emergency && !state.emergency.done) { state.route = null; nearestAssembly(); updateUrl(); return; }
    if (keepTo && keepTo !== id) { $("toSel").value = keepTo; showRoute(); return; }
    renderMap(); updateUrl();
    setSearchMode("to");
    $("searchBox").focus();
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  $("scanBtn").onclick = openScanner;
  $("scanClose").onclick = closeScanner;
  $("scanner").addEventListener("click", (e) => { if (e.target === $("scanner")) closeScanner(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("scanner").hidden) closeScanner(); });

  /* =================================================================
     COMPASS: a cone on "You are here" shows which way the phone faces.
     Assumes the map's "up" is north unless the site sets north (degrees).
     ================================================================= */
  let compassOn = false, coneRAF = 0;
  function requestCompass() {
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === "function") {
      D.requestPermission().then((r) => { if (r === "granted") startCompass(); }).catch(() => {});
    }
  }
  function startCompass() {
    if (compassOn || !window.DeviceOrientationEvent) return;
    compassOn = true;
    const onTurn = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading; // iPhone
      else if (e.absolute && typeof e.alpha === "number") h = 360 - e.alpha;      // Android
      if (h === null) return;
      h += (screen.orientation && screen.orientation.angle) || 0;
      state.heading = ((h % 360) + 360) % 360;
      if (!coneRAF) coneRAF = requestAnimationFrame(() => { coneRAF = 0; updateCone(); });
    };
    if ("ondeviceorientationabsolute" in window) window.addEventListener("deviceorientationabsolute", onTurn);
    else window.addEventListener("deviceorientation", onTurn);
  }
  let cone = null, coneAt = null;
  function updateCone() {
    if (!cone) return;
    if (state.heading === null) { cone.setAttribute("visibility", "hidden"); return; }
    const rad = ((state.heading - (state.site.north || 0)) * Math.PI) / 180;
    const a = P(coneAt.x, coneAt.y), b = P(coneAt.x + Math.sin(rad) * 10, coneAt.y - Math.cos(rad) * 10);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    cone.setAttribute("transform", `translate(${a[0].toFixed(1)},${a[1].toFixed(1)}) rotate(${ang.toFixed(1)})`);
    cone.setAttribute("visibility", "visible");
  }

  /* ---------- events ---------- */
  $("siteSelect").onchange = (e) => { state.here = null; loadSite(e.target.value); $("fromSel").value = ""; updateUrl(); };
  $("goBtn").onclick = () => showRoute();
  $("clearBtn").onclick = clearRoute;
  $("swap").onclick = () => { const a = $("fromSel").value; $("fromSel").value = $("toSel").value; $("toSel").value = a; if (state.route) showRoute(); };
  $("toSel").onchange = () => { if ($("fromSel").value) showRoute(); };
  $("prevStep").onclick = () => { setPlaying(false); goStep(state.step - 1); };
  $("nextStep").onclick = () => { setPlaying(false); goStep(state.step + 1); };
  // arrow keys step through the route (not while choosing in a list)
  document.addEventListener("keydown", (e) => {
    if (!state.route || /^(SELECT|INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowRight") { setPlaying(false); goStep(state.step + 1); }
    if (e.key === "ArrowLeft") { setPlaying(false); goStep(state.step - 1); }
  });
  // swipe the step card left / right on phones
  let swipe = null;
  const card = document.querySelector(".step-card");
  card.addEventListener("pointerdown", (e) => { swipe = [e.clientX, e.clientY]; });
  card.addEventListener("pointerup", (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe[0], dy = e.clientY - swipe[1];
    swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { setPlaying(false); goStep(state.step + (dx < 0 ? 1 : -1)); }
  });
  $("apBtn").onclick = () => startEmergency(false);
  $("drillBtn").onclick = () => startEmergency(true);
  $("routeSummary").addEventListener("click", (e) => { if (e.target.closest(".share-btn")) shareRoute(); });
  $("safetyToggle").onclick = () => {
    state.safety = !state.safety;
    $("safetyToggle").setAttribute("aria-pressed", String(state.safety));
    renderLegend(); renderMap();
  };
  $("facToggle").onclick = () => {
    state.facilities = !state.facilities;
    $("facToggle").setAttribute("aria-pressed", String(state.facilities));
    renderMap();
  };
  $("viewToggle").onclick = () => {
    state.view = state.view === "iso" ? "plan" : "iso";
    store.set("view", state.view);
    applyStaticText();
    animateView({ tilt: state.view === "iso" ? 1 : 0 }, 650);
  };
  $("rotL").onclick = () => { setFollow(false); animateView({ ang: Math.round(state.ang / 90) * 90 - 90 }); };
  $("rotR").onclick = () => { setFollow(false); animateView({ ang: Math.round(state.ang / 90) * 90 + 90 }); };
  $("northBtn").onclick = () => { setFollow(false); animateView({ ang: Math.round(state.ang / 360) * 360 }); };
  $("followBtn").onclick = () => { setFollow(!state.follow); if (state.follow) aimCamera(); };
  $("dayBtn").onclick = () => {
    state.dayMode = { auto: "day", day: "night", night: "auto" }[state.dayMode];
    store.set("day", state.dayMode);
    renderDayBtn(); renderMap();
  };
  document.querySelectorAll(".lang button").forEach((b) => (b.onclick = () => {
    state.lang = b.dataset.lang; store.set("lang", state.lang);
    const keep = state.route && !state.route.error;
    if (canSpeak) speechSynthesis.cancel();
    fillSiteSelect(); fillPoiSelects(); fillPopular(); fillTours(); fillNearby(); fillInfo(); applyStaticText(); renderLegend(); renderPlayBtn(); renderVoiceBtn(); setSearchMode(search.mode);
    if (keep) rerunRoute(true);
    else renderMap();
    renderSafetyNotes(); renderEmergBar();
  }));

  /* ---------- start ---------- */
  if (!I18N[state.lang]) state.lang = "en";
  renderPlayBtn(); renderVoiceBtn(); renderOpts(); setSearchMode("to"); renderDayBtn(); setFollow(state.follow);
  if (state.here) startCompass();
  loadSite(params.get("site") || store.get("site") || SITES[0].id);
  updateCompass();
  const startFrom = params.get("from") || state.here;
  if (startFrom && state.site.pois?.some((p) => p.id === startFrom)) $("fromSel").value = startFrom;
  const startTour = (state.site.tours || []).find((x) => x.id === params.get("tour"));
  if (params.get("emergency") === "1" || params.get("drill") === "1") startEmergency(params.get("drill") === "1");
  else if (startTour) showTour(startTour);
  else if (params.get("to") && state.site.pois?.some((p) => p.id === params.get("to"))) { $("toSel").value = params.get("to"); showRoute(); }
  else renderMap();
  window.addEventListener("beforeunload", () => store.set("site", state.site.id));
})();
