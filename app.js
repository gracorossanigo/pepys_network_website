/* The World of Samuel Pepys — an affiliation network that grows over diary time.
 *
 * Pepys himself is the implicit narrator and is not drawn; every person node is
 * someone who appears in his diary. This is a two-mode (affiliation) network:
 *   • "People" view  — people linked when they shared a gathering (one-mode projection)
 *   • "People + Events" view — people + the gatherings themselves, linked by attendance
 *
 * Layout has two schemes chosen by view (see ARCHITECTURE.md §4.4):
 *   • People — a graph-theoretic spring embedder (UCINET/NetDraw style): node
 *     repulsion + uniform-length edge springs + light gravity. Central actors sink
 *     to the middle emergently; no artificial forces, so no degree rings.
 *   • People + Events — the sparse two-mode graph instead anchors each person to
 *     their distance-tied Kamada-Kawai position and lets each event follow its
 *     attendees. New actors enter from the OUTSIDE as the network grows.
 */
(function () {
  "use strict";

  const DATA = window.PEPYS_DATA;
  const events = DATA.events;
  const meta = DATA.meta;
  const N = events.length;

  // ---- persistent person objects (positions survive every rebuild) ----------
  const byId = new Map();
  for (const n of DATA.nodes) {
    byId.set(n.id, {
      id: n.id, kind: "person",
      first: n.first, firstYear: +n.first.slice(0, 4),
      count: n.count, degreeFull: n.degree,
      px: n.px, py: n.py, x: 0, y: 0, ax: 0, ay: 0, cur: 0, placed: false,
    });
  }

  // ---- persistent event objects + per-day one-mode pairs --------------------
  // Each gathering keeps its full guest list in `membersFull`; `members` is the
  // list actually shown, which drops anyone the user has removed from the network
  // (see `removed`). A gathering left with fewer than two guests is "orphaned"
  // and goes dark (alive === false): it contributes no node, no attendance link
  // and no person-person pair.
  const eById = new Map();
  events.forEach((ev, i) => {
    for (const g of ev.groups) {
      eById.set(g.i, {
        id: g.i, kind: "event", date: ev.date, membersFull: g.m, members: g.m,
        size: g.m.length, dayIndex: i, x: 0, y: 0, ax: 0, ay: 0, cur: g.m.length,
        alive: true,
      });
    }
  });
  const allEvents = [...eById.values()];

  // People the user has taken out of the network. Empty === the full network.
  const removed = new Set();

  // Recompute every gathering's surviving guest list and each day's person-person
  // pairs from `removed`. Runs once at startup and again whenever `removed`
  // changes; the persistent event objects (and their positions) stay put.
  function refreshDerived() {
    const on = removed.size > 0;
    events.forEach((ev) => {
      ev.pairs = [];
      const seen = new Set();
      for (const g of ev.groups) {
        const e = eById.get(g.i);
        const m = on ? g.m.filter((p) => !removed.has(p)) : g.m;
        e.members = m;
        e.size = m.length;
        // A gathering only goes "orphaned" if a removal shrank it below two
        // guests; gatherings the removal never touched are left exactly as they
        // were (the data has 24 legitimate one-guest gatherings — Pepys seeing
        // someone alone — that must survive when nobody has been removed).
        e.alive = m.length === g.m.length ? m.length >= 1 : m.length >= 2;
        if (!e.alive) continue;
        for (let a = 0; a < m.length; a++) {
          for (let b = a + 1; b < m.length; b++) {
            const key = m[a] < m[b] ? m[a] + "" + m[b] : m[b] + "" + m[a];
            if (!seen.has(key)) { seen.add(key); ev.pairs.push([m[a], m[b], key]); }
          }
        }
      }
    });
  }
  refreshDerived();

  // ---- colour / size --------------------------------------------------------
  // Node fills are the one thing CSS can't set for us (d3 writes the `fill`
  // attribute), so they're read out of the same custom properties the legend
  // uses — style.css stays the single source of truth for the palette.
  const YEARS = [1664, 1665, 1666, 1667];
  const YEAR_COLOR = {};
  function readPalette() {
    const css = getComputedStyle(document.documentElement);
    const token = (name) => css.getPropertyValue(name).trim();
    YEARS.forEach((y, i) => { YEAR_COLOR[y] = token(`--year-${i + 1}`); });
    YEAR_COLOR.other = token("--year-other");
  }
  readPalette();
  const colorFor = (d) => YEAR_COLOR[d.firstYear] || YEAR_COLOR.other;
  // gentle size encoding — sqrt already compresses; small multiplier keeps the
  // busiest hubs from dwarfing everyone else
  const radiusFor = (d) => d.kind === "event"
    ? 2.5 + Math.sqrt(d.size) * 0.8
    : 2.8 + Math.sqrt(d.degreeFull) * 0.55;

  // ---- svg scaffold ---------------------------------------------------------
  const svg = d3.select("#graph");
  const root = svg.append("g").attr("class", "viewport");
  const gEdges = root.append("g").attr("class", "edges");   // person-person
  const gBip = root.append("g").attr("class", "bip");       // person-event
  const gEvents = root.append("g").attr("class", "events"); // event squares
  const gNodes = root.append("g").attr("class", "nodes");   // people circles
  const gLabels = root.append("g").attr("class", "labels");
  const tooltip = d3.select("#tooltip");

  // Nodes are anchored to their distance-tied (Kamada-Kawai) positions. SPREAD adds
  // local repulsion (a charge force) that inflates the dense core so it stops
  // clumping, while the anchors keep the overall distance-tied structure. Higher
  // SPREAD = more repulsion = more spread out.
  let SPREAD = 5;

  let W = 0, H = 0;
  function measure() {
    const r = svg.node().getBoundingClientRect();
    W = r.width || 960; H = r.height || 620;
    const m = Math.min(W, H) * 0.06 + 22;
    const side = Math.min(W, H) - 2 * m;          // uniform square keeps distances honest
    const ox = (W - side) / 2, oy = (H - side) / 2;
    for (const d of byId.values()) { d.ax = ox + d.px * side; d.ay = oy + d.py * side; }
    // an event sits at the centroid of the people who attended it (its live
    // membership — an orphaned gathering may have been emptied out entirely)
    for (const e of eById.values()) {
      if (!e.members.length) continue;
      let sx = 0, sy = 0;
      for (const p of e.members) { const o = byId.get(p); sx += o.ax; sy += o.ay; }
      e.ax = sx / e.members.length; e.ay = sy / e.members.length;
    }
  }
  measure();
  for (const d of byId.values()) { d.x = d.ax; d.y = d.ay; }
  for (const e of eById.values()) { e.x = e.ax; e.y = e.ay; }

  // ---- force sim ------------------------------------------------------------
  // Two layout schemes share one simulation, selected by `mode`:
  //
  //  PEOPLE view — a graph-theoretic spring embedder (à la UCINET/NetDraw): every
  //    node repels every other (charge), edges are springs of one UNIFORM rest
  //    length (link), and a whisper of gravity keeps it centred. Central actors
  //    sink to the middle on their own (many edges pull them in from all sides),
  //    so there is NO artificial degree force and therefore no rings.
  //
  //  PEOPLE + EVENTS view — the two-mode graph is a sparse, tree-ish thing that a
  //    spring embedder just sprawls, so instead we anchor each person to their
  //    distance-tied Kamada-Kawai position (ax/ay) and let each event track the
  //    live centroid of its attendees (forceEvents). Charge only de-clumps.
  //
  // Each force below is turned on/off per mode by its strength in applySpreadForce.
  const charge = d3.forceManyBody();
  const link = d3.forceLink([]).id((d) => d.id);
  const anchorX = d3.forceX((d) => d.ax);   // KK anchor (two-mode people)
  const anchorY = d3.forceY((d) => d.ay);
  const gravityX = d3.forceX((d) => W / 2); // centring (people spring layout)
  const gravityY = d3.forceY((d) => H / 2);

  let simEventNodes = [];                    // events in the sim (two-mode only)
  function forceEvents() {
    for (const e of simEventNodes) {
      let sx = 0, sy = 0; const n = e.members.length;
      for (const p of e.members) { const o = byId.get(p); sx += o.x; sy += o.y; }
      e.vx += (sx / n - e.x) * 0.4;
      e.vy += (sy / n - e.y) * 0.4;
    }
  }

  const sim = d3.forceSimulation([])
    .force("link", link)
    .force("charge", charge)
    .force("ax", anchorX)
    .force("ay", anchorY)
    .force("gx", gravityX)
    .force("gy", gravityY)
    .force("events", forceEvents)
    .force("collide", d3.forceCollide((d) => radiusFor(d) + 1.5).strength(0.85))
    .alphaDecay(0.035)
    .velocityDecay(0.34)
    .on("tick", ticked);

  function applySpreadForce() {
    const two = mode === "two";
    if (two) {
      // Anchored two-mode: people held near their KK spot, events follow attendees.
      // Events now repel about as hard as people (they used to be charge -4, i.e.
      // basically inert) — and because many-body charge is pairwise across every
      // node, those event squares also shove the surrounding people outward, so the
      // cloud inflates to a spread comparable to the People view instead of
      // collapsing onto the dense KK core. distanceMax is widened to match so the
      // repulsion actually reaches across the core, and the anchor is eased a touch
      // to give it room while still holding the distance-tied structure.
      charge.strength((d) => d.kind === "event"
          ? -(8 + SPREAD * SPREAD * 2)
          : -(8 + SPREAD * SPREAD * 2.4))
        .distanceMax(180 + SPREAD * 44);
      anchorX.strength((d) => d.kind === "event" ? 0 : 0.36);
      anchorY.strength((d) => d.kind === "event" ? 0 : 0.36);
      gravityX.strength(0); gravityY.strength(0);
    } else {
      // spring embedder: repulsion + uniform springs + light gravity
      charge.strength(-(14 + SPREAD * SPREAD * 3.2)).distanceMax(300 + SPREAD * 20);
      link.distance(18 + SPREAD * 6);
      anchorX.strength(0); anchorY.strength(0);
      gravityX.x(W / 2).strength(0.045); gravityY.y(H / 2).strength(0.045);
    }
  }
  // (applySpreadForce is invoked from rebuild()/applySpread() once `mode` exists)

  // fit once the layout has cooled (node count/spread change how long that takes,
  // so a fixed timer is unreliable) — request a fit and let the tick loop do it.
  let fitPending = false, fitAnimate = false;
  function requestFit(animate) { fitPending = true; fitAnimate = animate; }

  let nodeSel = gNodes.selectAll("circle");
  let eventSel = gEvents.selectAll("rect");
  let edgeSel = gEdges.selectAll("line");
  let bipSel = gBip.selectAll("line");
  let labelSel = gLabels.selectAll("text");

  function ticked() {
    edgeSel
      .attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
    bipSel
      .attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
    nodeSel.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
    eventSel.attr("x", (d) => d.x - radiusFor(d)).attr("y", (d) => d.y - radiusFor(d));
    labelSel.attr("x", (d) => d.x).attr("y", (d) => d.y - radiusFor(d) - 4);
    if (fitPending && sim.alpha() < 0.09) { fitPending = false; fitView(fitAnimate); }
  }

  // ---- zoom / pan -----------------------------------------------------------
  const zoom = d3.zoom().scaleExtent([0.05, 8]).on("zoom", (e) => {
    root.attr("transform", e.transform);
  });
  svg.call(zoom).on("dblclick.zoom", null);

  // fit the current node cloud into the viewport (used after spread changes so the
  // inflated layout stays framed). Uses a robust extent so a few far outliers /
  // disconnected dyads don't shrink everything.
  function fitView(animate) {
    const pts = (sim.nodes().length ? sim.nodes() : [...byId.values()]);
    if (!pts.length) return;
    let cx = 0, cy = 0;
    for (const d of pts) { cx += d.x; cy += d.y; }
    cx /= pts.length; cy /= pts.length;
    const ds = pts.map((d) => Math.hypot(d.x - cx, d.y - cy)).sort((a, b) => a - b);
    const R = Math.max(60, ds[Math.floor(ds.length * 0.93)] || 200);
    const pad = 40;
    const scale = Math.min((W / 2 - pad) / R, (H / 2 - pad) / R, 4);
    const t = d3.zoomIdentity.translate(W / 2 - scale * cx, H / 2 - scale * cy).scale(scale);
    (animate ? svg.transition().duration(600) : svg).call(zoom.transform, t);
  }

  // ---- state ----------------------------------------------------------------
  let index = 0;
  let mode = "people";     // "people" | "two"
  let hovered = null;

  function stateAt(k) {
    // Only surviving (alive) gatherings put people on the stage, so anyone who
    // was left stranded once a removed person emptied out their gatherings simply
    // never becomes active — the orphan cascade falls straight out of this.
    const activePeople = new Set();
    for (let i = 0; i < k; i++)
      for (const g of events[i].groups) {
        const e = eById.get(g.i);
        if (!e.alive) continue;
        for (const p of e.members) activePeople.add(p);
      }

    if (mode === "people") {
      const pairWeight = new Map(), pairEnds = new Map();
      for (let i = 0; i < k; i++) {
        for (const [a, b, key] of events[i].pairs) {   // pairs already drop removed/orphaned
          pairWeight.set(key, (pairWeight.get(key) || 0) + 1);
          if (!pairEnds.has(key)) pairEnds.set(key, [a, b]);
        }
      }
      return { activePeople, pairWeight, pairEnds };
    }
    // two-mode: alive events whose day has occurred, plus attendance links
    const activeEvents = [];
    for (const e of allEvents) if (e.alive && e.dayIndex < k) activeEvents.push(e);
    return { activePeople, activeEvents };
  }

  function rebuild(k, reheat) {
    index = k;
    if (k === 0) for (const o of byId.values()) o.placed = false;  // fresh replay
    const st = stateAt(k);

    const nodes = [];
    for (const id of st.activePeople) { const o = byId.get(id); o.cur = 0; nodes.push(o); }

    // Seed the positions of people appearing for the first time. Two cases:
    //  • a handful arriving during forward play → born on the OUTSIDE of the cloud
    //    and pulled inward (the nice "newcomer enters from the edge" effect);
    //  • a bulk load / big jump → seeded at their Kamada-Kawai anchor so the spring
    //    embedder starts near-solved and converges fast (a ring-of-hundreds seed
    //    never settles in time, especially in the denser two-mode graph).
    const newcomers = nodes.filter((o) => !o.placed);
    const havePlaced = nodes.length > newcomers.length;
    const cx = W / 2, cy = H / 2;
    if (havePlaced && newcomers.length <= 8) {
      let cloudR = Math.min(W, H) * 0.16;
      for (const o of nodes) if (o.placed) cloudR = Math.max(cloudR, Math.hypot(o.x - cx, o.y - cy));
      const rOut = cloudR + 70;
      for (const o of newcomers) {
        const ang = Math.atan2(o.ay - cy, o.ax - cx);   // enter from its own sector
        o.x = cx + Math.cos(ang) * rOut; o.y = cy + Math.sin(ang) * rOut;
        o.vx = 0; o.vy = 0;
      }
    } else {
      for (const o of newcomers) { o.x = o.ax; o.y = o.ay; o.vx = 0; o.vy = 0; }
    }
    for (const o of newcomers) o.placed = true;

    let links = [], bip = [], eventNodes = [];

    if (mode === "people") {
      for (const [key, w] of st.pairWeight) {
        const [a, b] = st.pairEnds.get(key);
        const s = byId.get(a), t = byId.get(b);
        s.cur++; t.cur++;
        links.push({ source: s, target: t, key, w });
      }
    } else {
      eventNodes = st.activeEvents;
      for (const e of eventNodes) {
        for (const p of e.members) {
          const o = byId.get(p); o.cur++;
          bip.push({ source: o, target: e, key: e.id + "" + p });
        }
      }
    }

    const labelThreshold = labelCutoff(nodes);

    // ---- data joins ---------------------------------------------------------
    edgeSel = gEdges.selectAll("line").data(links, (d) => d.key);
    edgeSel.exit().remove();
    edgeSel = edgeSel.enter().append("line").attr("class", "edge")
      .attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.source.x).attr("y2", (d) => d.source.y)
      .merge(edgeSel).attr("stroke-width", (d) => Math.min(4, 0.7 + d.w * 0.5));

    bipSel = gBip.selectAll("line").data(bip, (d) => d.key);
    bipSel.exit().remove();
    bipSel = bipSel.enter().append("line").attr("class", "bip")
      .attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.source.x).attr("y2", (d) => d.source.y)
      .merge(bipSel);

    eventSel = gEvents.selectAll("rect").data(eventNodes, (d) => d.id);
    eventSel.exit().remove();
    const evEnter = eventSel.enter().append("rect").attr("class", "event")
      .attr("width", 0).attr("height", 0)
      .attr("x", (d) => d.x).attr("y", (d) => d.y)
      .attr("rx", 1.5)
      .on("mouseover", onHover).on("mousemove", moveTip).on("mouseout", offHover)
      .call(dragBehavior());
    evEnter.transition().duration(400)
      .attr("width", (d) => radiusFor(d) * 2).attr("height", (d) => radiusFor(d) * 2);
    eventSel = evEnter.merge(eventSel)
      .attr("width", (d) => radiusFor(d) * 2).attr("height", (d) => radiusFor(d) * 2);

    nodeSel = gNodes.selectAll("circle").data(nodes, (d) => d.id);
    nodeSel.exit().remove();
    const nodeEnter = nodeSel.enter().append("circle").attr("class", "node")
      .attr("r", 0).attr("cx", (d) => d.x).attr("cy", (d) => d.y).attr("fill", colorFor)
      .on("mouseover", onHover).on("mousemove", moveTip).on("mouseout", offHover)
      .call(dragBehavior());
    nodeEnter.transition().duration(420).attr("r", radiusFor);
    nodeSel = nodeEnter.merge(nodeSel).attr("fill", colorFor);

    labelSel = gLabels.selectAll("text")
      .data(nodes.filter((d) => d.cur >= labelThreshold), (d) => d.id);
    labelSel.exit().remove();
    labelSel = labelSel.enter().append("text").attr("class", "label")
      .attr("text-anchor", "middle").text((d) => prettyName(d.id)).merge(labelSel);

    // ---- feed the simulation ------------------------------------------------
    simEventNodes = eventNodes;
    applySpreadForce();
    sim.nodes(mode === "two" ? nodes.concat(eventNodes) : nodes);
    link.links(mode === "two" ? [] : links);   // spring edges only in people mode
    sim.alpha(Math.max(sim.alpha(), reheat ? 0.6 : 0.2)).restart();

    updateReadout(k, nodes.length, mode === "people" ? links.length : bip.length, eventNodes.length);
    updateLeaderboard(nodes);
    if (hovered && !st.activePeople.has(hovered) && !eById.has(hovered)) { hovered = null; clearHighlight(); }
  }

  function labelCutoff(nodes) {
    if (nodes.length <= 14) return 1;
    const degs = nodes.map((d) => d.cur).sort((a, b) => b - a);
    const cap = degs[Math.min(degs.length - 1, 24)];
    return Math.max(3, cap);
  }

  // ---- hover ----------------------------------------------------------------
  function highlightId(id) {         // dim everything except a node and its neighbours
    hovered = id;
    const nbr = new Set([id]);
    const activeEdges = mode === "people" ? edgeSel : bipSel;
    activeEdges.each(function (e) {
      if (e.source.id === id) nbr.add(e.target.id);
      else if (e.target.id === id) nbr.add(e.source.id);
    });
    nodeSel.classed("dim", (o) => !nbr.has(o.id));
    eventSel.classed("dim", (o) => !nbr.has(o.id));
    labelSel.classed("dim", (o) => !nbr.has(o.id));
    activeEdges
      .classed("hot", (e) => e.source.id === id || e.target.id === id)
      .classed("dim", (e) => !(e.source.id === id || e.target.id === id));
  }
  function onHover(event, d) { highlightId(d.id); showTip(event, d); }
  function offHover() { hovered = null; clearHighlight(); tooltip.classed("hidden", true); }
  function clearHighlight() {
    nodeSel.classed("dim", false);
    eventSel.classed("dim", false);
    labelSel.classed("dim", false);
    edgeSel.classed("hot", false).classed("dim", false);
    bipSel.classed("hot", false).classed("dim", false);
  }
  function showTip(event, d) {
    let html;
    if (d.kind === "event") {
      const names = d.members.map(prettyName);
      const shown = names.slice(0, 8).join(", ") + (names.length > 8 ? `, +${names.length - 8} more` : "");
      html = `<div class="tt-name">A gathering</div>` +
        `<div class="tt-row">${fmtDate(d.date)} · ${d.size} ${d.size === 1 ? "person" : "people"}</div>` +
        `<div class="tt-row">${shown}</div>`;
    } else {
      const unit = mode === "people" ? "connection" : "gathering";
      html = `<div class="tt-name">${prettyName(d.id)}</div>` +
        `<div class="tt-row">First appears ${fmtDate(d.first)}</div>` +
        `<div class="tt-row">${d.cur} ${unit}${d.cur === 1 ? "" : "s"} so far · ` +
        `${d.count} gathering${d.count === 1 ? "" : "s"} total</div>` +
        `<div class="tt-hint">Click to remove from the network</div>`;
    }
    tooltip.classed("hidden", false).html(html);
    moveTip(event);
  }
  function moveTip(event) {
    const r = svg.node().getBoundingClientRect();
    tooltip.style("left", (event.clientX - r.left) + "px").style("top", (event.clientY - r.top) + "px");
  }

  function dragBehavior() {
    // A near-stationary press (as opposed to a real drag) on a person node is a
    // click: it removes that person from the network. We measure travel in screen
    // pixels off the source event so zoom level doesn't change the threshold.
    let downX = 0, downY = 0, moved = false;
    return d3.drag()
      .on("start", (e, d) => {
        moved = false;
        const se = e.sourceEvent;
        if (se) { downX = se.clientX; downY = se.clientY; }
        if (!e.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag", (e, d) => {
        const se = e.sourceEvent;
        if (se && Math.hypot(se.clientX - downX, se.clientY - downY) > 4) moved = true;
        d.fx = e.x; d.fy = e.y;
      })
      .on("end", (e, d) => {
        if (!e.active) sim.alphaTarget(0);
        d.fx = null; d.fy = null;
        if (!moved && d.kind === "person") removePerson(d.id);
      });
  }

  // ---- readouts -------------------------------------------------------------
  const elDate = document.getElementById("stat-date");
  const elPeople = document.getElementById("stat-people");
  const elLinks = document.getElementById("stat-links");
  const elGroups = document.getElementById("stat-groups");
  const linkLbl = document.querySelector("#stat-links + .lbl");

  function updateReadout(k, nPeople, nLinks, nEvents) {
    elDate.textContent = k === 0 ? "—" : fmtDate(events[k - 1].date);
    elPeople.textContent = nPeople;
    elLinks.textContent = nLinks;
    linkLbl.textContent = mode === "people" ? "Connections" : "Attendances";
    let g = 0;
    for (let i = 0; i < k; i++)
      for (const grp of events[i].groups) if (eById.get(grp.i).alive) g++;   // orphaned gatherings drop out
    elGroups.textContent = g;
    slider.value = k;
    document.getElementById("hint").classList.toggle("gone", k !== 0);
    highlightChapter(k);
  }

  // ---- leaderboard: the top 10 nodes at the current moment -------------------
  const lbList = document.getElementById("lb-list");
  const lbTitle = document.getElementById("lb-title");
  let lbNodes = [];
  function updateLeaderboard(nodes) {
    lbNodes = nodes;
    lbTitle.textContent = mode === "people" ? "Most connected" : "Most present";
    if (!nodes.length) { lbList.innerHTML = '<li class="lb-empty">Nobody yet</li>'; return; }
    const top = nodes.slice()
      .sort((a, b) => b.cur - a.cur || b.degreeFull - a.degreeFull)
      .slice(0, 10);
    lbList.innerHTML = top.map((d, i) => {
      const safe = d.id.replace(/"/g, "&quot;");
      return `<li data-id="${safe}">` +
        `<span class="lb-rank">${i + 1}</span>` +
        `<span class="lb-dot" style="background:${colorFor(d)}"></span>` +
        `<span class="lb-name">${prettyName(d.id)}</span>` +
        `<span class="lb-val">${d.cur}</span>` +
        `<button class="lb-remove" data-remove="${safe}" title="Remove ${prettyName(d.id)} from the network">&times;</button>` +
        `</li>`;
    }).join("");
  }
  // hovering a leaderboard row highlights that actor in the graph
  lbList.addEventListener("mouseover", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) highlightId(li.getAttribute("data-id"));
  });
  lbList.addEventListener("mouseleave", () => { hovered = null; clearHighlight(); });
  // the "×" on a row takes that person out of the network
  lbList.addEventListener("click", (e) => {
    const btn = e.target.closest(".lb-remove");
    if (btn) { e.stopPropagation(); removePerson(btn.getAttribute("data-remove")); }
  });

  // ---- removal: take a person out of the network and re-derive ---------------
  // Removing a person strips them from every gathering (never deleting the
  // gathering outright) and then drops any gathering left with a single guest —
  // that lone guest can in turn disappear if they had no other gathering, so the
  // orphan removal cascades naturally through refreshDerived()/stateAt().
  const removedPanel = document.getElementById("removed-panel");
  const removedList = document.getElementById("removed-list");

  function applyRemovalChange() {
    refreshDerived();
    measure();                 // gathering anchors depend on their live membership
    renderRemovedPanel();
    hovered = null; clearHighlight(); tooltip.classed("hidden", true);
    rebuild(index, true);
    requestFit(true);
  }
  function removePerson(id) {
    if (!id || removed.has(id)) return;
    removed.add(id);
    applyRemovalChange();
  }
  function restorePerson(id) {
    if (!removed.delete(id)) return;
    applyRemovalChange();
  }
  function restoreAll() {
    if (!removed.size) return;
    removed.clear();
    applyRemovalChange();
  }
  function renderRemovedPanel() {
    if (!removed.size) { removedPanel.classList.add("gone"); removedList.innerHTML = ""; return; }
    removedPanel.classList.remove("gone");
    const chips = [...removed].sort().map((id) => {
      const safe = id.replace(/"/g, "&quot;");
      return `<li><span class="rm-name">${prettyName(id)}</span>` +
        `<button class="rm-restore" data-restore="${safe}" title="Put ${prettyName(id)} back">&times;</button></li>`;
    }).join("");
    removedList.innerHTML = chips;
  }
  removedList.addEventListener("click", (e) => {
    const btn = e.target.closest(".rm-restore");
    if (btn) restorePerson(btn.getAttribute("data-restore"));
  });
  document.getElementById("restore-all").addEventListener("click", restoreAll);

  // ---- formatting -----------------------------------------------------------
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  function fmtDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }
  function prettyName(id) {
    return id.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  }

  // ---- controls -------------------------------------------------------------
  const slider = document.getElementById("slider");
  slider.max = N;
  const playBtn = document.getElementById("play");
  const resetBtn = document.getElementById("reset");
  const speedSel = document.getElementById("speed");
  let playing = false, timer = null;

  function play() {
    if (index >= N) rebuild(0, false);
    playing = true;
    document.body.classList.add("playing");
    playBtn.querySelector(".btn-text").textContent = "Pause";
    timer = d3.interval(() => {
      const next = Math.min(N, index + (+speedSel.value));
      rebuild(next, next - index > 3);
      if (next >= N) pause();
    }, 130);
  }
  function pause() {
    playing = false;
    document.body.classList.remove("playing");
    playBtn.querySelector(".btn-text").textContent = index >= N ? "Replay" : "Play";
    if (timer) { timer.stop(); timer = null; }
  }
  playBtn.addEventListener("click", () => playing ? pause() : play());
  resetBtn.addEventListener("click", () => { pause(); rebuild(0, false); playBtn.querySelector(".btn-text").textContent = "Play"; });
  slider.addEventListener("input", () => { pause(); const k = +slider.value; rebuild(k, Math.abs(k - index) > 20); });

  // ---- mode toggle ----------------------------------------------------------
  const btnPeople = document.getElementById("mode-people");
  const btnTwo = document.getElementById("mode-two");
  function setMode(m) {
    if (m === mode) return;
    mode = m;
    document.body.classList.toggle("two-mode", m === "two");
    btnPeople.classList.toggle("active", m === "people");
    btnTwo.classList.toggle("active", m === "two");
    rebuild(index, true);
    requestFit(true);
  }
  btnPeople.addEventListener("click", () => setMode("people"));
  btnTwo.addEventListener("click", () => setMode("two"));

  // ---- spread control -------------------------------------------------------
  const spreadInput = document.getElementById("spread");
  const spreadVal = document.getElementById("spread-val");
  function applySpread(v, refit) {
    SPREAD = v;
    spreadInput.value = v;
    spreadVal.innerHTML = v + "&times;";
    applySpreadForce();
    sim.alpha(0.75).restart();
    if (refit) requestFit(true);
  }
  spreadInput.addEventListener("change", () => applySpread(+spreadInput.value, true));
  spreadInput.addEventListener("input", () => {
    SPREAD = +spreadInput.value;
    spreadVal.innerHTML = SPREAD + "&times;";
    applySpreadForce();
    sim.alpha(0.5).restart();
  });

  // ---- chapter jump buttons -------------------------------------------------
  const chapterWrap = document.getElementById("chapter-buttons");
  const chapterIndex = [];
  meta.chapters.forEach((c) => {
    let k = events.findIndex((e) => e.date >= c.date);
    if (k < 0) k = N;
    chapterIndex.push(k);
    const btn = document.createElement("button");
    btn.className = "chapter-btn";
    btn.textContent = c.label;
    btn.title = c.note;
    btn.addEventListener("click", () => { pause(); rebuild(k, true); });
    chapterWrap.appendChild(btn);
  });
  const fullBtn = document.createElement("button");
  fullBtn.className = "chapter-btn";
  fullBtn.textContent = "Whole Network";
  fullBtn.title = "Everyone across all four years";
  fullBtn.addEventListener("click", () => { pause(); rebuild(N, true); });
  chapterWrap.appendChild(fullBtn);
  chapterIndex.push(N);

  function highlightChapter(k) {
    const btns = chapterWrap.querySelectorAll(".chapter-btn");
    let active = -1;
    for (let i = 0; i < chapterIndex.length; i++) if (k >= chapterIndex[i]) active = i;
    btns.forEach((b, i) => b.classList.toggle("active", i === active && k > 0));
  }

  // ---- year ticks -----------------------------------------------------------
  const ticksWrap = document.getElementById("ticks");
  YEARS.forEach((y) => {
    let k = events.findIndex((e) => e.date >= `${y}-01-01`);
    if (k < 0) return;
    const t = document.createElement("div");
    t.className = "tick";
    t.style.left = (k / N * 100) + "%";
    t.textContent = y;
    ticksWrap.appendChild(t);
  });

  // ---- theme ----------------------------------------------------------------
  // Everything else re-colours itself through CSS; only the fills we wrote by
  // hand need repainting (see readPalette).
  window.addEventListener("themechange", () => {
    readPalette();
    nodeSel.attr("fill", colorFor);
    updateLeaderboard(lbNodes);
  });

  // ---- resize ---------------------------------------------------------------
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { measure(); sim.alpha(0.4).restart(); requestFit(false); }, 150);
  });

  // ---- go -------------------------------------------------------------------
  let start = 0;
  const hm = /(?:^#|&)k=(full|\d+)/.exec(location.hash);
  if (hm) start = hm[1] === "full" ? N : Math.max(0, Math.min(N, +hm[1]));
  const sp = /(?:^#|&)spread=([\d.]+)/.exec(location.hash);
  if (sp) SPREAD = Math.max(1, Math.min(8, +sp[1]));
  if (/(?:^#|&)mode=two/.test(location.hash)) setMode("two");
  applySpread(SPREAD, false);
  rebuild(start, start > 0);
  requestFit(false);   // frame it once the initial layout has settled
})();
