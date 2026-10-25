/* 便签配色用的取色盘：SV 方块挑饱和度/明度、色相条挑色相、也能直接敲 #rrggbb。
 *
 * 用法：
 *   openColorPicker({ x, y, value, presets, onChange, onDone })
 *   - onChange(color) 拖动/点选时实时回调，调用方直接改卡片内联样式即可（不落库）
 *   - onDone(color)   面板关闭时回调一次，调用方在这里写库
 *   - Esc 视为取消：先把颜色还原成打开时的值，再关闭（不调用 onDone）
 *   - allowAlpha 打开后多一条透明度滑条，颜色以 #rrggbbaa 返回（只有画布用）
 *
 * 面板是挂在 body 下的独立浮层，不是 #ctx-menu 的子节点：点它内部既不会触发
 * 「点外部关菜单」，也不会被右键菜单重建时误伤。同一时刻只会存在一个面板。 */

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/* #rgb / #rrggbb / #rrggbbaa 都认；返回 { hex, alpha }（alpha 0-255），非法返回 null */
export function parseColor(raw) {
  if (typeof raw !== "string") return null;
  let value = raw.trim().replace(/^#/, "");
  if (value.length === 3 || value.length === 4) {
    value = value
      .split("")
      .map((c) => c + c)
      .join("");
  }
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) return null;
  value = value.toLowerCase();
  return {
    hex: `#${value.slice(0, 6)}`,
    alpha: value.length === 8 ? parseInt(value.slice(6), 16) : 255,
  };
}

/* 只要 #rrggbb（旧调用方） */
export function parseHex(raw) {
  return parseColor(raw)?.hex ?? null;
}

/* 完全透明也保留色值（#rrggbb00），跟「无填充」的空字符串是两回事 */
function withAlpha(hex, alpha) {
  if (!hex) return "";
  const a = Math.round(clamp(alpha, 0, 255));
  return a >= 255 ? hex : `${hex}${a.toString(16).padStart(2, "0")}`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }) {
  const part = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

function rgbToHsv({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToRgb(h, s, v) {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = v - c;
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

let open = null; // 当前打开的面板状态

export function closeColorPicker(commit = true) {
  if (!open) return;
  const state = open;
  open = null;
  document.removeEventListener("pointerdown", state.onDocDown, true);
  document.removeEventListener("keydown", state.onKeyDown, true);
  state.panel.remove();
  if (commit) state.onDone?.(state.current);
}

/**
 * 打开取色盘。
 * @param {object} opts
 * @param {number} opts.x 右键位置（面板会贴在这个点附近，并自动收回窗口内）
 * @param {number} opts.y
 * @param {string} opts.value 打开时的颜色；空字符串表示当前就是透明
 * @param {string} [opts.seed] value 为空时取色盘初始停靠的颜色（只影响显示，不改值）
 * @param {string[]} [opts.presets] 预设色块（点一下即用）
 * @param {boolean} [opts.allowNone] 显示透明项，点击后回调空字符串并关闭
 * @param {string} [opts.noneLabel] 透明项的文案（填充用「无填充」，边框用「透明」）
 * @param {boolean} [opts.allowAlpha] 显示透明度滑条，结果带 alpha（画布用）
 * @param {(color: string) => void} [opts.onChange] 实时预览
 * @param {(color: string) => void} [opts.onDone] 关闭时落库
 */
export function openColorPicker({
  x = 0,
  y = 0,
  value,
  seed,
  presets = [],
  allowNone = false,
  noneLabel = "无填充",
  allowAlpha = false,
  onChange,
  onDone,
} = {}) {
  closeColorPicker(true); // 旧面板先按「确定」收尾，保证它的变更不会丢

  const initialColor = parseColor(value);
  const initial = allowAlpha
    ? withAlpha(initialColor?.hex ?? "", initialColor?.alpha ?? 255)
    : initialColor?.hex ?? "";
  // 已有颜色时停靠在实际颜色上；seed 只用于「当前无颜色」的占位显示
  const startHex = parseHex(value) || parseHex(seed) || "#000000";
  let baseHex = initialColor?.hex ?? "";
  let alpha = allowAlpha ? initialColor?.alpha ?? 255 : 255;
  let current = initial;
  const hsv = rgbToHsv(hexToRgb(startHex));

  const panel = document.createElement("div");
  panel.className = "color-pop";
  panel.innerHTML = `
    <div class="color-pop-sv" role="slider" aria-label="饱和度和明度" tabindex="0">
      <span class="color-pop-cursor"></span>
    </div>
    <div class="color-pop-hue" role="slider" aria-label="色相" tabindex="0">
      <span class="color-pop-hue-cursor"></span>
    </div>
    <div class="color-pop-alpha-row" hidden>
      <div class="color-pop-alpha" role="slider" aria-label="透明度" tabindex="0">
        <span class="color-pop-alpha-cursor"></span>
      </div>
      <span class="color-pop-alpha-value"></span>
    </div>
    <div class="color-pop-foot">
      <span class="color-pop-chip"></span>
      <input class="color-pop-hex" spellcheck="false" maxlength="9" aria-label="十六进制色值" />
      <button class="color-pop-none" type="button" hidden>无填充</button>
    </div>
    <div class="color-pop-presets"></div>
  `;

  const sv = panel.querySelector(".color-pop-sv");
  const cursor = panel.querySelector(".color-pop-cursor");
  const hueBar = panel.querySelector(".color-pop-hue");
  const hueCursor = panel.querySelector(".color-pop-hue-cursor");
  const alphaRow = panel.querySelector(".color-pop-alpha-row");
  const alphaBar = panel.querySelector(".color-pop-alpha");
  const alphaCursor = panel.querySelector(".color-pop-alpha-cursor");
  const alphaValue = panel.querySelector(".color-pop-alpha-value");
  const chip = panel.querySelector(".color-pop-chip");
  const hexInput = panel.querySelector(".color-pop-hex");
  const noneBtn = panel.querySelector(".color-pop-none");
  const presetRow = panel.querySelector(".color-pop-presets");

  const paint = () => {
    const shown = current || "transparent";
    sv.style.background =
      `linear-gradient(to top, #000, rgba(0, 0, 0, 0)), ` +
      `linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`;
    cursor.style.left = `${hsv.s * 100}%`;
    cursor.style.top = `${(1 - hsv.v) * 100}%`;
    cursor.style.background = shown;
    hueCursor.style.left = `${clamp(hsv.h / 360, 0, 1) * 100}%`;
    chip.style.backgroundColor = shown;
    alphaRow.hidden = !allowAlpha;
    if (allowAlpha) {
      alphaBar.classList.toggle("is-disabled", !baseHex);
      alphaBar.style.backgroundImage =
        `linear-gradient(to right, transparent, ${baseHex || "transparent"}), ` +
        `repeating-conic-gradient(#e6e6e6 0% 25%, #ffffff 0% 50%)`;
      alphaCursor.style.left = `${(alpha / 255) * 100}%`;
      alphaValue.textContent = `${Math.round((alpha / 255) * 100)}%`;
    }
    if (document.activeElement !== hexInput) {
      hexInput.value = current;
      hexInput.placeholder = current ? "" : "透明";
    }
  };

  const emit = () => {
    paint();
    onChange?.(current);
  };

  const setFromHsv = () => {
    baseHex = rgbToHex(hsvToRgb(hsv.h, hsv.s, hsv.v));
    current = withAlpha(baseHex, alpha);
    emit();
  };

  const setFromHex = (hex, nextAlpha = alpha) => {
    const next = rgbToHsv(hexToRgb(hex));
    // 纯黑/纯白这类没有色相的颜色，保留用户刚选好的色相，免得色相条自己跳回红
    if (next.s > 0.001) hsv.h = next.h;
    hsv.s = next.s;
    hsv.v = next.v;
    baseHex = hex;
    if (allowAlpha) alpha = clamp(nextAlpha, 0, 255);
    current = withAlpha(baseHex, alpha);
    emit();
  };

  const setFromAlpha = (nextAlpha) => {
    if (!baseHex) return;
    alpha = clamp(nextAlpha, 0, 255);
    current = withAlpha(baseHex, alpha);
    emit();
  };

  /* SV 方块：按下即取色并捕获指针，拖动时连续跟手 */
  const trackSv = (e) => {
    const rect = sv.getBoundingClientRect();
    hsv.s = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    hsv.v = 1 - clamp((e.clientY - rect.top) / rect.height, 0, 1);
    setFromHsv();
  };
  sv.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    sv.setPointerCapture(e.pointerId);
    trackSv(e);
    const move = (ev) => trackSv(ev);
    const up = () => {
      sv.removeEventListener("pointermove", move);
      sv.removeEventListener("pointerup", up);
      sv.removeEventListener("pointercancel", up);
    };
    sv.addEventListener("pointermove", move);
    sv.addEventListener("pointerup", up);
    sv.addEventListener("pointercancel", up);
  });

  /* 色相条 */
  const trackHue = (e) => {
    const rect = hueBar.getBoundingClientRect();
    hsv.h = clamp((e.clientX - rect.left) / rect.width, 0, 1) * 359.9;
    setFromHsv();
  };
  hueBar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    hueBar.setPointerCapture(e.pointerId);
    trackHue(e);
    const move = (ev) => trackHue(ev);
    const up = () => {
      hueBar.removeEventListener("pointermove", move);
      hueBar.removeEventListener("pointerup", up);
      hueBar.removeEventListener("pointercancel", up);
    };
    hueBar.addEventListener("pointermove", move);
    hueBar.addEventListener("pointerup", up);
    hueBar.addEventListener("pointercancel", up);
  });

  /* 透明度条：左端全透明、右端当前色，底下垫棋盘格表示透出来的底 */
  const trackAlpha = (e) => {
    if (!baseHex) return;
    const rect = alphaBar.getBoundingClientRect();
    setFromAlpha(clamp((e.clientX - rect.left) / rect.width, 0, 1) * 255);
  };
  alphaBar.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    alphaBar.setPointerCapture(e.pointerId);
    trackAlpha(e);
    const move = (ev) => trackAlpha(ev);
    const up = () => {
      alphaBar.removeEventListener("pointermove", move);
      alphaBar.removeEventListener("pointerup", up);
      alphaBar.removeEventListener("pointercancel", up);
    };
    alphaBar.addEventListener("pointermove", move);
    alphaBar.addEventListener("pointerup", up);
    alphaBar.addEventListener("pointercancel", up);
  });

  /* 直接敲色值：输入过程中合法就跟手，回车/失焦时把显示规整回合法色值 */
  hexInput.addEventListener("input", () => {
    const next = parseColor(hexInput.value);
    if (next && withAlpha(next.hex, next.alpha) !== current) {
      setFromHex(next.hex, next.alpha);
    }
  });
  hexInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      hexInput.blur();
    }
  });
  hexInput.addEventListener("change", () => {
    const next = parseColor(hexInput.value);
    if (next) setFromHex(next.hex, next.alpha);
    else hexInput.value = current;
  });

  noneBtn.hidden = !allowNone;
  noneBtn.textContent = noneLabel;
  noneBtn.addEventListener("click", () => {
    baseHex = "";
    current = "";
    onChange?.("");
    closeColorPicker(true);
  });

  for (const color of presets) {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "color-pop-preset";
    dot.style.background = color;
    dot.title = color;
    dot.setAttribute("aria-label", `使用 ${color}`);
    dot.addEventListener("click", () => setFromHex(color));
    presetRow.append(dot);
  }
  presetRow.hidden = presets.length === 0;

  const onDocDown = (e) => {
    if (!e.composedPath().includes(panel)) closeColorPicker(true);
  };
  const onKeyDown = (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    e.preventDefault();
    // Esc = 取消：还原成打开时的颜色，不落库
    current = initial;
    onChange?.(initial);
    closeColorPicker(false);
  };

  document.body.append(panel);
  const rect = panel.getBoundingClientRect();
  panel.style.left = `${clamp(x, 8, window.innerWidth - rect.width - 8)}px`;
  panel.style.top = `${clamp(y, 8, window.innerHeight - rect.height - 8)}px`;

  open = {
    panel,
    onDone,
    onDocDown,
    onKeyDown,
    // current 是随拖动不断变的局部变量，必须每次现取；快照下来会永远是打开时的颜色
    get current() {
      return current;
    },
  };
  // 面板高度会随内容定，定位算完再挂监听，避免开面板那一下就被自己关掉
  document.addEventListener("pointerdown", onDocDown, true);
  document.addEventListener("keydown", onKeyDown, true);

  paint();
}
