// main.js
// expects data.csv with columns: date,name,tier,lp
// date: YYYY-MM-DD
// lp: number (NaN treated as 0)

const WIDTH = 1920;
const HEIGHT = 1080;

const margin = { top: 70, right: 270, bottom: 110, left: 110 };
const innerW = WIDTH - margin.left - margin.right;
const innerH = HEIGHT - margin.top - margin.bottom;

const TOP_N = 15;

// total play time for moving parts (pauses add on top)
const DURATION = 180000;

const SMOOTH_Y = 0.10;     // rank movement smoothing
const SMOOTH_AXIS = 0.12;  // axis zoom smoothing

const LABEL_HIDE_BAR_PX = 150;
const AXIS_HEADROOM = 1.06;
const TICK_STEP = 400;     // 0,400,800... labeled as IRON, BRONZE...

const LEADIN_DAYS = 7;

// pause config
const PAUSE_MS = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;

// extra pause days (YYYY-MM-DD) - will SNAP too
const EXTRA_PAUSE_DATES = [
  "2025-12-22",
];

const svg = d3.select("#chart")
  .attr("width", WIDTH)
  .attr("height", HEIGHT);

const root = svg.append("g")
  .attr("transform", `translate(${margin.left},${margin.top})`);

const fmtDate = d3.timeFormat("%Y-%m-%d");

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }
function endOfDayMs(ms){ return ms + (DAY_MS - 1); }

// --- Tier system (400 per major tier, 100 per division, +LP) ---
const TIERS = ["Iron","Bronze","Silver","Gold","Platinum","Emerald","Diamond","Master","Grandmaster","Challenger"];
const DIVS = ["IV","III","II","I"]; // low -> high
const DIV_INDEX = new Map(DIVS.map((d,i)=>[d,i]));

const tierColors = new Map([
  ["Iron",       "#6b7280"],
  ["Bronze",     "#b87333"],
  ["Silver",     "#c0c0c0"],
  ["Gold",       "#d4af37"],
  ["Platinum",   "#44d0c6"],
  ["Emerald",    "#2ecc71"],
  ["Diamond",    "#7c4dff"],
  ["Master",     "#c2185b"],
  ["Grandmaster","#ff3b30"],
  ["Challenger", "#f5c542"],
]);

function parseTier(tierStr){
  if (!tierStr) return null;
  const parts = String(tierStr).trim().split(/\s+/);
  const tier = parts[0] || null;
  const div = parts[1] || null;
  if (!tier || !TIERS.includes(tier)) return null;
  return { tier, div };
}
function hasDivision(tier){
  return !["Master","Grandmaster","Challenger"].includes(tier);
}

// points encoding:
// - division tiers: tierIndex*400 + divIndex*100 + lp(0..99)
// - master+:        tierIndex*400 + lp (clamp 0..999)
function encodePoints(tierStr, lp){
  const p = parseTier(tierStr);
  if (!p) return null;
  const ti = TIERS.indexOf(p.tier);
  if (ti < 0) return null;

  const lpNum = Number.isFinite(lp) ? lp : 0;

  if (hasDivision(p.tier)){
    const di = DIV_INDEX.has(p.div) ? DIV_INDEX.get(p.div) : 0;
    const lpClamped = Math.max(0, Math.min(99, lpNum));
    return ti * 400 + di * 100 + lpClamped;
  } else {
    const lpClamped = Math.max(0, Math.min(999, lpNum));
    return ti * 400 + lpClamped;
  }
}

function decodePoints(points){
  if (!Number.isFinite(points)) return { tierStr: null, tierKey: null, lp: 0 };

  const p = Math.max(0, points);
  const ti = Math.max(0, Math.min(TIERS.length - 1, Math.floor(p / 400)));
  const tier = TIERS[ti];
  const rem = p - ti * 400;

  if (hasDivision(tier)){
    const di = Math.max(0, Math.min(3, Math.floor(rem / 100)));
    const lp = Math.max(0, Math.min(99, Math.floor(rem - di * 100)));
    const div = DIVS[di];
    return { tierStr: `${tier} ${div}`, tierKey: tier, lp };
  } else {
    const lp = Math.max(0, Math.floor(rem));
    return { tierStr: tier, tierKey: tier, lp };
  }
}

function barColorFromPoints(points){
  const d = decodePoints(points);
  return tierColors.get(d.tierKey) || "#9ca3af";
}
function displayLabelFromPoints(points){
  const d = decodePoints(points);
  if (!d.tierStr) return "";
  return `${d.tierStr} ${d.lp}LP`;
}

// --- smoothing state ---
const yState = new Map(); // for y positions

function smoothValue(map, key, target, alpha){
  const cur = map.has(key) ? map.get(key) : target;
  const next = cur + (target - cur) * alpha;
  map.set(key, next);
  return next;
}

// --- enter slide-in: track who was present last frame ---
let presentPrev = new Set();

// --- button UI ---
const playBtn = document.getElementById("playBtn");
const playIcon = document.getElementById("playIcon");
const playText = document.getElementById("playText");
const playSub  = document.getElementById("playSub");

function setButtonUI(playing, progress){
  if (!playBtn) return;
  if (playing){
    playIcon.textContent = "⏸";
    playText.textContent = "Pause";
    playSub.textContent = "Pause animation";
  } else {
    playIcon.textContent = "▶";
    playText.textContent = (progress > 0 && progress < 1) ? "Resume" : "Play";
    playSub.textContent = (progress > 0 && progress < 1) ? "Continue" : "Start animation";
  }
}

// --- season segments (start date resets everyone) ---
const PDATE = d3.timeParse("%Y-%m-%d");
const SEGS = [
  { start: PDATE("2019-01-23"), label: "S9" },
  { start: PDATE("2020-01-10"), label: "S10" },
  { start: PDATE("2021-01-08"), label: "S11" },
  { start: PDATE("2022-01-07"), label: "S12" },
  { start: PDATE("2023-01-11"), label: "S13-1" },
  { start: PDATE("2023-07-19"), label: "S13-2" },
  { start: PDATE("2024-01-10"), label: "S14-1" },
  { start: PDATE("2024-05-15"), label: "S14-2" },
  { start: PDATE("2024-09-25"), label: "S14-3" },
  { start: PDATE("2025-01-09"), label: "S15" },
].sort((a,b)=>+a.start-+b.start);

const segBisect = d3.bisector(d => +d.start).right;

function getSeg(ms){
  const i = segBisect(SEGS, ms) - 1;
  if (i < 0) return null;
  const start = +SEGS[i].start;
  const end = (i + 1 < SEGS.length) ? +SEGS[i + 1].start : Infinity;
  return { start, end, label: SEGS[i].label, index: i };
}

d3.csv("./data.csv", d => ({
  date: PDATE(d.date),
  name: d.name,
  tier: (d.tier && String(d.tier).trim().length ? String(d.tier).trim() : null),
  lp: (+d.lp || 0),
})).then(raw => {
  raw = raw.filter(d => d.date && !isNaN(d.date));
  raw = raw.map(r => ({ ...r, points: encodePoints(r.tier, r.lp) }));

  const names = Array.from(new Set(raw.map(d => d.name))).sort();

  // group by name
  const recByName = new Map();
  for (const n of names) recByName.set(n, []);
  for (const r of raw) recByName.get(r.name).push(r);
  for (const [n, arr] of recByName) arr.sort((a,b)=>a.date-b.date);

  const allDates = raw.map(d => +d.date);
  const startMs = Math.min(...allDates);
  const endMs = Math.max(...allDates);
  const effectiveStartMs = startMs - LEADIN_DAYS * DAY_MS;

  const bisectDate = d3.bisector(d => +d.date).right;

  // pause points (SNAP)
  const pausePoints = [];

  // (1) season end pauses: next season start - 1 day, but pause at end-of-day
  for (let i = 0; i < SEGS.length - 1; i++){
    const segStart = +SEGS[i].start;
    const nextStart = +SEGS[i+1].start;
    const seasonEndDay00 = nextStart - DAY_MS;
    const pauseMs = endOfDayMs(seasonEndDay00);
    if (pauseMs < segStart) continue;
    if (pauseMs > endMs) continue;

    pausePoints.push({
      ms: pauseMs,
      msEnd: pauseMs,
      segStart,
      segEnd: nextStart,
      label: SEGS[i].label,
      segIndex: i,
      kind: "snap"
    });
  }

  // (2) extra pauses: also pause at end-of-day
  for (const s of EXTRA_PAUSE_DATES){
    const dt = PDATE(s);
    if (!dt) continue;
    const pauseMs = endOfDayMs(+dt);
    if (pauseMs < effectiveStartMs || pauseMs > endMs) continue;

    const seg = getSeg(pauseMs);
    pausePoints.push({
      ms: pauseMs,
      msEnd: pauseMs,
      segStart: seg ? seg.start : -Infinity,
      segEnd: seg ? seg.end : Infinity,
      label: seg ? seg.label : "",
      segIndex: seg ? seg.index : -1,
      kind: "snap"
    });
  }

  // sort & de-dup
  pausePoints.sort((a,b)=>a.ms-b.ms);
  const dedup = [];
  for (const p of pausePoints){
    if (dedup.length && dedup[dedup.length - 1].ms === p.ms) continue;
    dedup.push(p);
  }
  pausePoints.length = 0;
  pausePoints.push(...dedup);

  // snapshot within segment (no cross-season interpolation)
  function snapshot(ms){
    const seg = getSeg(ms);
    if (!seg) return names.map(name => ({ name, points: null }));

    const rows = [];
    for (const name of names){
      const recs = recByName.get(name);
      if (!recs || recs.length === 0){
        rows.push({ name, points: null });
        continue;
      }

      const i = bisectDate(recs, ms);
      if (i === 0){
        rows.push({ name, points: null });
        continue;
      }

      const prev = recs[i - 1];

      if (+prev.date < seg.start){
        rows.push({ name, points: null });
        continue;
      }

      if (i >= recs.length){
        rows.push({ name, points: prev.points });
        continue;
      }

      const next = recs[i];

      if (+next.date >= seg.end){
        rows.push({ name, points: prev.points });
        continue;
      }

      const t0 = +prev.date, t1 = +next.date;
      if (t1 === t0){
        rows.push({ name, points: next.points });
        continue;
      }

      if (prev.points === null || next.points === null){
        rows.push({ name, points: null });
        continue;
      }

      const u = clamp01((ms - t0) / (t1 - t0));
      rows.push({ name, points: lerp(prev.points, next.points, u) });
    }
    return rows;
  }

  // SNAP snapshot: last record inside [segStart, segEnd) up to msEnd
  function snapshotFinal(segStart, segEnd, msEnd){
    const rows = [];
    for (const name of names){
      const recs = recByName.get(name);
      if (!recs || recs.length === 0){
        rows.push({ name, points: null });
        continue;
      }

      const i = bisectDate(recs, msEnd);
      if (i === 0){
        rows.push({ name, points: null });
        continue;
      }

      const prev = recs[i - 1];
      if (+prev.date < segStart || +prev.date >= segEnd){
        rows.push({ name, points: null });
        continue;
      }

      rows.push({ name, points: prev.points });
    }
    return rows;
  }

  function rank(rows){
    const filtered = rows.filter(d => d.points !== null);
    filtered.sort((a,b)=>b.points-a.points);
    for (let i=0; i<filtered.length; i++) filtered[i].rank = i;
    return filtered.slice(0, TOP_N);
  }

  // layout
  const barGap = 10;
  const barH = (innerH - (TOP_N - 1) * barGap) / TOP_N;

  // enter slide starts from below
  const ENTER_Y = innerH + barH * 0.8;

  const x = d3.scaleLinear().range([0, innerW]);
  const y = d3.scaleBand()
    .domain(d3.range(TOP_N))
    .range([0, innerH])
    .paddingInner(barGap / (barH + barGap));

  const gridG = root.append("g").attr("class","grid");
  const ticksG = root.append("g").attr("class","tick");

  const seasonHud = svg.append("text")
    .attr("text-anchor","end")
    .attr("x", WIDTH - 40)
    .attr("y", HEIGHT - 40 - 92)
    .style("fill","rgba(255,255,255,0.70)")
    .style("font","56px Pretendard");

  const dateHud = svg.append("text")
    .attr("class","dateHud")
    .attr("text-anchor","end")
    .attr("x", WIDTH - 40)
    .attr("y", HEIGHT - 40);

  const barsG = root.append("g");
  const labelsG = root.append("g");
  const valuesG = root.append("g");

  let axisMaxCur = 1;

  function updateAxis(dt, topPoints, snap){
    const alpha = snap ? 1 : (1 - Math.pow(1 - SMOOTH_AXIS, dt / 16.7));
    const target = Math.max(1, topPoints * AXIS_HEADROOM);
    axisMaxCur = axisMaxCur + (target - axisMaxCur) * alpha;

    x.domain([0, axisMaxCur]);

    const maxTick = Math.max(TICK_STEP, Math.ceil(axisMaxCur / TICK_STEP) * TICK_STEP);
    const ticks = d3.range(0, maxTick + 0.0001, TICK_STEP);

    gridG.selectAll("line")
      .data(ticks, d => d)
      .join(
        enter => enter.append("line").attr("y1", 0).attr("y2", innerH),
        update => update,
        exit => exit.remove()
      )
      .attr("x1", d => x(d))
      .attr("x2", d => x(d))
      .attr("y2", innerH);

    ticksG.selectAll("text")
      .data(ticks, d => d)
      .join(
        enter => enter.append("text").attr("y", -12),
        update => update,
        exit => exit.remove()
      )
      .attr("x", d => x(d))
      .attr("text-anchor","middle")
      .text(d => {
        const idx = Math.round(d / 400);
        return TIERS[idx] ?? "";
      });
  }

  function ensureEnterSlide(name, targetY, targetYName, targetYVal){
    // if previously absent, initialize its y state from below for slide-in
    if (!presentPrev.has(name)){
      yState.set(`b:${name}`, ENTER_Y);
      yState.set(`n:${name}`, ENTER_Y + barH * 0.70);
      yState.set(`v:${name}`, ENTER_Y + barH * 0.70);
    }
  }

  // render at ms
  function renderAtMs(ms, dt, holdSnap, snapInfo){
    const dateObj = new Date(ms);

    const alphaY = holdSnap ? 1 : (1 - Math.pow(1 - SMOOTH_Y, dt / 16.7));

    let rows;
    let snap = false;

    if (holdSnap && snapInfo && snapInfo.kind === "snap"){
      rows = snapshotFinal(snapInfo.segStart, snapInfo.segEnd, snapInfo.msEnd);
      snap = true;
    } else {
      rows = snapshot(ms);
    }

    const ranked = rank(rows);

    // axis
    const topPoints = ranked.length ? ranked[0].points : 1;
    updateAxis(dt, topPoints, snap);

    // current present set
    const presentNow = new Set(ranked.map(d => d.name));

    // initialize enter-slide for new arrivals (only in non-snap mode)
    if (!holdSnap){
      for (const d of ranked){
        const ty = y(d.rank);
        ensureEnterSlide(d.name, ty, ty + barH * 0.70, ty + barH * 0.70);
      }
    }

    // bars
    barsG.selectAll("rect")
      .data(ranked, d => d.name)
      .join(
        enter => enter.append("rect")
          .attr("x", 0)
          .attr("height", barH)
          .attr("rx", 14),
        update => update,
        exit => exit.remove()
      )
      .attr("y", d => smoothValue(yState, `b:${d.name}`, y(d.rank), alphaY))
      .attr("width", d => x(d.points))
      .attr("fill", d => barColorFromPoints(d.points));

    // name inside bar (right-aligned inside)
    labelsG.selectAll("text")
      .data(ranked, d => d.name)
      .join(
        enter => enter.append("text")
          .attr("class","name")
          .attr("text-anchor","end")
          .style("pointer-events","none"),
        update => update,
        exit => exit.remove()
      )
      .attr("x", d => x(d.points) - 14)
      .attr("y", d => smoothValue(yState, `n:${d.name}`, y(d.rank) + barH * 0.70, alphaY))
      .style("opacity", d => (x(d.points) >= LABEL_HIDE_BAR_PX ? 1 : 0))
      .text(d => d.name);

    // right label
    valuesG.selectAll("text")
      .data(ranked, d => d.name)
      .join(
        enter => enter.append("text")
          .attr("class","valueText")
          .attr("text-anchor","start")
          .style("pointer-events","none"),
        update => update,
        exit => exit.remove()
      )
      .attr("x", d => x(d.points) + 18)
      .attr("y", d => smoothValue(yState, `v:${d.name}`, y(d.rank) + barH * 0.70, alphaY))
      .text(d => displayLabelFromPoints(d.points));

    // update prev present (after rendering)
    presentPrev = presentNow;

    // HUD
    const seg = getSeg(ms);
    seasonHud.text(seg ? seg.label : "");
    dateHud.text(fmtDate(dateObj));
  }

  // ---- playhead with pauses ----
  let playing = false;
  let raf = null;

  let playMs = effectiveStartMs;
  let lastPerf = 0;

  const totalSpan = (endMs - effectiveStartMs);
  const speed = totalSpan > 0 ? (totalSpan / DURATION) : 0;

  let pauseRemaining = 0;
  let pauseIndex = 0;
  let activeSnap = null;

  function msToProgress(ms){
    if (totalSpan <= 0) return 0;
    return clamp01((ms - effectiveStartMs) / totalSpan);
  }
  function progressToMs(p){
    return effectiveStartMs + clamp01(p) * totalSpan;
  }
  function updatePauseIndexForMs(ms){
    let i = 0;
    while (i < pausePoints.length && pausePoints[i].ms <= ms) i++;
    pauseIndex = i;
    pauseRemaining = 0;
    activeSnap = null;
  }

  // scrubber
  const scrubber = document.getElementById("scrubber");
  let isScrubbing = false;

  function syncScrubber(){
    if (!scrubber) return;
    if (!isScrubbing) scrubber.value = String(msToProgress(playMs));
  }

  if (scrubber){
    scrubber.addEventListener("pointerdown", () => { isScrubbing = true; });
    window.addEventListener("pointerup", () => { isScrubbing = false; syncScrubber(); });

    scrubber.addEventListener("input", (e) => {
      const p = +e.target.value;
      const ms = progressToMs(p);
      updatePauseIndexForMs(ms);
      playMs = ms;

      // scrubbing은 즉시 보여주는게 낫고 enter-slide 의미 없음
      renderAtMs(playMs, 16.7, true, null);
      setButtonUI(playing, msToProgress(playMs));
      syncScrubber();
    });

    scrubber.value = "0";
  }

  function stop(){
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    setButtonUI(false, msToProgress(playMs));
    syncScrubber();
  }

  function startOrResume(){
    if (playing) return;
    playing = true;
    setButtonUI(true, msToProgress(playMs));
    lastPerf = performance.now();

    function loop(){
      const now = performance.now();
      const dt = now - lastPerf;
      lastPerf = now;

      // pause mode
      if (pauseRemaining > 0){
        pauseRemaining -= dt;
        renderAtMs(playMs, dt, true, activeSnap);
        syncScrubber();

        if (pauseRemaining <= 0){
          activeSnap = null;
          pauseRemaining = 0;
        }
        raf = requestAnimationFrame(loop);
        return;
      }

      // normal step
      let targetMs = playMs + dt * speed;

      // end => hard SNAP once then stop
      if (targetMs >= endMs){
        playMs = endMs;
        const seg = getSeg(playMs);
        const finalSnap = seg ? {
          kind: "snap",
          ms: playMs,
          msEnd: endOfDayMs(playMs),
          segStart: seg.start,
          segEnd: seg.end,
          label: seg.label,
          segIndex: seg.index
        } : null;

        renderAtMs(playMs, dt, true, finalSnap);
        syncScrubber();
        stop();
        return;
      }

      // hit next pause?
      if (pauseIndex < pausePoints.length){
        const pp = pausePoints[pauseIndex];
        if (playMs < pp.ms && targetMs >= pp.ms){
          playMs = pp.ms;
          activeSnap = pp;
          pauseRemaining = PAUSE_MS;
          pauseIndex++;

          // immediate snap render
          renderAtMs(playMs, dt, true, activeSnap);
          syncScrubber();

          raf = requestAnimationFrame(loop);
          return;
        }
      }

      playMs = targetMs;
      renderAtMs(playMs, dt, false, null);
      syncScrubber();

      raf = requestAnimationFrame(loop);
    }

    raf = requestAnimationFrame(loop);
  }

  function toggle(){
    if (playing) stop();
    else startOrResume();
  }

  if (playBtn) playBtn.addEventListener("click", toggle);

  // init
  updatePauseIndexForMs(playMs);
  setButtonUI(false, msToProgress(playMs));
  renderAtMs(playMs, 16.7, false, null);
  syncScrubber();
});
