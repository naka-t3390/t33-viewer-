// 端末(KYV46)の縦型記録画面を再現するパネル。
//
// 並びは端末の `RecordingDashboardPortrait` に合わせてある:
//   上帯 → 速度(全幅・主役) → 電池 → 前後モーター(横並び) → 下段[左カード | e-4ORCE 俯瞰図]
// 左カードはシフト・READY・e-Pedal → 温度/負荷の 2×2 → 前後配分。
//
// **配色は端末と同じ暗色で固定**し、ビューアのテーマには追従させない(端末画面の再現なので、
// 明るいテーマの中でも「端末の画面」として読めるほうがよい。2026-11-28 の所有者指定)。
//
// 値の意味と「取れていない値はグレー」の約束は `cockpit-model.js` が持つ。ここは描くだけ。

import { cockpitModelOf } from "./cockpit-model.js";
import { e4orceStateOf, drawTopView, CenterOfGravityTrail } from "./e4orce-topview.js";

/** 速度バーの上限(km/h)。端末の MetricRanges.SPEED_MAX_KMH と同じ。 */
const SPEED_MAX_KMH = 180;

const HTML = `
<div class="cp-head">
  <span class="cp-title">T33 Monitor</span>
  <span class="cp-rec">● REC</span>
  <span class="cp-clock" data-cp="clock">0:00.0</span>
</div>
<div class="cp-nocan" data-cp="nocan">CAN なし</div>

<div class="cp-card cp-speed-card">
  <div class="cp-row cp-labels">
    <span class="cp-label cp-green">VEHICLE SPEED</span>
    <span class="cp-label cp-amber" data-cp="peak">PEAK -- km/h</span>
  </div>
  <div class="cp-row cp-baseline">
    <span class="cp-speed" data-cp="speed">0</span><span class="cp-unit-lg">km/h</span>
  </div>
  <div class="cp-bar"><i data-cp="speedbar"></i></div>
</div>

<div class="cp-card cp-bms">
  <div class="cp-bms-grid">
    <div class="cp-bms-cell"><span class="cp-k">電圧</span><span class="cp-v" data-cp="volt">---</span><span class="cp-u">V</span></div>
    <div class="cp-bms-cell"><span class="cp-k">電流</span><span class="cp-v" data-cp="amp">---</span><span class="cp-u">A</span></div>
    <div class="cp-bms-cell"><span class="cp-k">SOC</span><span class="cp-v" data-cp="soc">---</span><span class="cp-u">%</span></div>
    <div class="cp-bms-cell"><span class="cp-k">発電</span><span class="cp-v" data-cp="erpm">0</span><span class="cp-u">rpm</span></div>
  </div>
  <div class="cp-row cp-power-row">
    <span class="cp-k">電池電力</span>
    <span class="cp-power" data-cp="power">---</span><span class="cp-u">kW</span>
    <span class="cp-note">負が放電</span>
  </div>
</div>

<div class="cp-motors">
  <div class="cp-card cp-motor">
    <div class="cp-row cp-baseline cp-motor-head">
      <span class="cp-motor-title">前モーター</span>
      <span class="cp-motor-kw cp-front" data-cp="front-kw">+0.0 kW</span>
    </div>
    <div class="cp-stat"><span class="cp-k">トルク</span><span class="cp-stat-v" data-cp="front-tq">0</span><span class="cp-u">Nm</span></div>
    <div class="cp-stat"><span class="cp-k">回転数</span><span class="cp-stat-v" data-cp="front-rpm">0</span><span class="cp-u">rpm</span></div>
  </div>
  <div class="cp-card cp-motor">
    <div class="cp-row cp-baseline cp-motor-head">
      <span class="cp-motor-title">後モーター</span>
      <span class="cp-motor-kw cp-rear" data-cp="rear-kw">+0.0 kW</span>
    </div>
    <div class="cp-stat"><span class="cp-k">トルク</span><span class="cp-stat-v" data-cp="rear-tq">0</span><span class="cp-u">Nm</span></div>
    <div class="cp-stat"><span class="cp-k">回転数</span><span class="cp-stat-v" data-cp="rear-rpm">0</span><span class="cp-u">rpm</span></div>
  </div>
</div>

<div class="cp-bottom">
  <div class="cp-card cp-left">
    <div class="cp-shift-row">
      <div class="cp-shift" data-cp="shift">-</div>
      <div class="cp-lamps">
        <div class="cp-lamp" data-cp="ready">READY</div>
        <div class="cp-lamp" data-cp="epedal">e-Pedal</div>
      </div>
    </div>
    <div class="cp-chips">
      <div class="cp-chip"><span class="cp-k">水温</span><span class="cp-chip-v" data-cp="coolant">--</span></div>
      <div class="cp-chip"><span class="cp-k">油温</span><span class="cp-chip-v" data-cp="oil">--</span></div>
      <div class="cp-chip"><span class="cp-k">吸気</span><span class="cp-chip-v" data-cp="intake">--</span></div>
      <div class="cp-chip"><span class="cp-k">負荷</span><span class="cp-chip-v" data-cp="load">--</span></div>
    </div>
    <div class="cp-split-bar"><i data-cp="splitbar"></i></div>
    <div class="cp-split" data-cp="split">前 0% : 後 0%</div>
  </div>
  <div class="cp-card cp-topview">
    <canvas data-cp="canvas"></canvas>
    <span class="cp-waiting" data-cp="waiting">e-4ORCE<br>データ待ち</span>
  </div>
</div>
`;

/** 秒を `m:ss.s` にする。 */
function clockText(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`;
}

/**
 * パネルを `root` の中に組み立てる。
 *
 * 返り値の `update(sample, tSec)` を再生ループから毎フレーム呼ぶ。`sample` は
 * `sampleCockpitAt` の戻り値(CAN が無い・範囲外なら null)。
 */
export function createCockpitPanel(root) {
  root.classList.add("cockpit-panel");
  root.innerHTML = HTML;

  const el = {};
  for (const node of root.querySelectorAll("[data-cp]")) el[node.dataset.cp] = node;

  const canvas = el.canvas;
  const ctx = canvas.getContext("2d");
  const trail = new CenterOfGravityTrail();
  // 文字を毎フレーム書き換えると無駄な再レイアウトが起きるので、変化したときだけ書く。
  const lastText = new Map();
  let peakKmh = 0;

  function setText(node, text) {
    if (lastText.get(node) === text) return;
    lastText.set(node, text);
    node.textContent = text;
  }

  /** `CockpitValue` を 1 つ描く。`verified` が false ならグレーにする。 */
  function setValue(node, v, suffix = "") {
    setText(node, v.text + suffix);
    node.classList.toggle("cp-unverified", !v.verified);
  }

  function resize() {
    // 文字は枠の**幅**に追従させる(縦に合わせると細長い枠で巨大になる)。
    // 端末の 720px 幅に対する比で組んであるので、幅の 4.2% を 1em にすると近い見え方になる。
    const panelW = root.clientWidth;
    if (panelW > 0) root.style.fontSize = `${Math.max(9, Math.min(17, panelW * 0.042))}px`;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** セッションを切り替えたら PEAK と残像を捨てる。 */
  function reset() {
    peakKmh = 0;
    trail.samples.length = 0;
    lastText.clear();
  }

  function update(sample, tSec) {
    const m = cockpitModelOf(sample);
    el.nocan.classList.toggle("cp-on", !m.hasCan);
    setText(el.clock, clockText(tSec));

    if (m.speed.verified && m.speedKmh > peakKmh) peakKmh = m.speedKmh;
    setText(el.peak, `PEAK ${Math.round(peakKmh)} km/h`);
    setValue(el.speed, m.speed);
    el.speedbar.style.width = `${Math.min(100, (m.speedKmh / SPEED_MAX_KMH) * 100)}%`;
    el.speedbar.classList.toggle("cp-unverified-bar", !m.speed.verified);

    setValue(el.volt, m.battery.volt);
    setValue(el.amp, m.battery.amp);
    setValue(el.soc, m.battery.soc);
    setValue(el.erpm, m.engineRpm);
    setValue(el.power, m.battery.power);
    // 放電(負)は緑、回生・充電(正)は赤。端末の DRIVE/REGEN と同じ意味づけ。
    el.power.classList.toggle("cp-discharge", m.battery.powerKw < 0);
    el.power.classList.toggle("cp-charge", m.battery.powerKw > 0);

    setValue(el["front-kw"], m.front.kw, " kW");
    setValue(el["front-tq"], m.front.torque);
    setValue(el["front-rpm"], m.front.rpm);
    setValue(el["rear-kw"], m.rear.kw, " kW");
    setValue(el["rear-tq"], m.rear.torque);
    setValue(el["rear-rpm"], m.rear.rpm);
    // 12bit の上限(±255.9Nm)に近い値は飽和の疑いがある。未解決なので印だけ出す。
    el["front-tq"].classList.toggle("cp-saturated", m.front.saturated);
    el["rear-tq"].classList.toggle("cp-saturated", m.rear.saturated);

    setValue(el.shift, m.shift);
    el.shift.classList.toggle("cp-reverse", m.shift.text === "R");
    el.ready.classList.toggle("cp-ready-on", m.ready);
    el.epedal.classList.toggle("cp-epedal-on", m.ePedal);

    setValue(el.coolant, m.coolant);
    setValue(el.oil, m.oil);
    setValue(el.intake, m.intake);
    setValue(el.load, m.load);

    setValue(el.split, m.axleSplit);
    el.splitbar.style.width = `${m.frontRatio * 100}%`;
    // 配分が取れていないときは帯ごとグレーにする。前を 0% にしただけだと
    // 後ろ側の紫が全部見えて「後 100%」に読めてしまう。
    el.splitbar.parentElement.classList.toggle("cp-unverified-bar", !m.axleSplit.verified);

    const state = e4orceStateOf(sample);
    el.waiting.classList.toggle("cp-on", state === null);
    // 枠が変わった(文字サイズやウィンドウの変化)なら描く前に作り直す。
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(canvas.clientWidth * dpr)) resize();
    drawTopView(ctx, canvas.clientWidth, canvas.clientHeight, state, tSec * 1000, trail);
  }

  resize();
  // セッションを開く前でも「CAN なし」の見た目で出しておく(空の黒箱にしない)。
  update(null, 0);
  return { update, resize, reset };
}
