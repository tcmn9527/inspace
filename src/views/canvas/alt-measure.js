/* 从 canvas.js 拆出：alt-measure */

import { CONNECTOR_MAX_POINTS, GEN_MIN_HEIGHT, GEN_MIN_WIDTH, PICTURE_MIN_HEIGHT, PICTURE_MIN_WIDTH, RESIZE_MIN, SCENE_MIN_HEIGHT, SCENE_MIN_WIDTH, TEXT_DEFAULT_WIDTH, active, addItemElement, applyCamera, assignMeasureHeld, bendInsertIndex, boundsOfItem, capturePagePin, clientToWorld, connectHit, connectorGeometry, current, drag, drawConnectPreview, drawSnapGuides, dropTool, editingId, findItem, finishConnect, finishConnectEnd, finishMarquee, finishPaint, fitGenPrompt, itemBounds, itemEls, loneSelected, makeBox, makeLine, makePicture, makeScene, makeText, measureFrame, measureHeld, nearestPathPoint, onPaintPointerMove, pinEbookPage, reassignContainerOwners, refreshConnectors, refreshMinimap, releaseEbookPage, removeItemFromDom, scheduleCameraSave, scheduleItemsSave, select, setConnectTarget, setDrag, setHoverId, setMeasureFrame, setTool, snapLineAngle, snapOffset, snapResize, startTextEdit, stretchEbookPage, syncConnector, syncItemElement, tool, ui, updateMarquee, updatePorts, updateSelection, worldToStage } from "../canvas.js";
import { clampGroupDx, clampXToPage } from "./page-width.js";

/* ---------- Alt 测距 ---------- */

/* 整块拖动要走出这么多个屏幕像素才算「真的在拖」，按缩放折成世界坐标。
   点块、按住块头部时手抖的那一两像素不算数。 */
const MOVE_SLOP_PX = 3;
/* 平移画布（点空白、按锁定块）同理：客户端像素，不用折缩放 */
const PAN_SLOP_PX = 3;

export function setMeasureHeld(on) {
  if (measureHeld === on) return;
  assignMeasureHeld(on);
  if (on) scheduleMeasurements();
  else clearMeasurements();
}

export function clearMeasurements() {
  if (measureFrame) {
    cancelAnimationFrame(measureFrame);
    setMeasureFrame(0);
  }
  if (ui?.measureLayer) ui.measureLayer.textContent = "";
}

export function scheduleMeasurements() {
  if (!measureHeld || measureFrame) return;
  setMeasureFrame(requestAnimationFrame(() => {
    setMeasureFrame(0);
    drawMeasurements();
  }));
}

/* 选中的块到四周最近面板的空隙：左右要求竖向有投影重叠，上下要求横向有重叠，
   只量真正“挨着的那一排/那一列”，不给斜对角硬拉一条线 */
export function drawMeasurements() {
  const layer = ui?.measureLayer;
  if (!layer) return;
  layer.textContent = "";
  if (!measureHeld || !active || !current || editingId) return;
  const id = loneSelected();
  if (!id) return;
  const item = findItem(id);
  const el = itemEls.get(id);
  if (!item || !el || item.type === "connector" || item.type === "line" || item.type === "arrow") return;
  const sel = itemBounds(item, el);
  const nearest = { left: null, right: null, top: null, bottom: null };
  for (const other of current.items) {
    if (other.id === id || other.type === "connector" || other.type === "line" || other.type === "arrow") continue;
    const otherEl = itemEls.get(other.id);
    if (!otherEl) continue;
    const b = itemBounds(other, otherEl);
    const overY = Math.min(sel.y + sel.h, b.y + b.h) - Math.max(sel.y, b.y);
    const overX = Math.min(sel.x + sel.w, b.x + b.w) - Math.max(sel.x, b.x);
    if (overY > 1) {
      const at = (Math.max(sel.y, b.y) + Math.min(sel.y + sel.h, b.y + b.h)) / 2;
      const leftGap = sel.x - (b.x + b.w);
      if (leftGap >= 0 && (!nearest.left || leftGap < nearest.left.gap)) {
        nearest.left = { gap: leftGap, b, at };
      }
      const rightGap = b.x - (sel.x + sel.w);
      if (rightGap >= 0 && (!nearest.right || rightGap < nearest.right.gap)) {
        nearest.right = { gap: rightGap, b, at };
      }
    }
    if (overX > 1) {
      const at = (Math.max(sel.x, b.x) + Math.min(sel.x + sel.w, b.x + b.w)) / 2;
      const topGap = sel.y - (b.y + b.h);
      if (topGap >= 0 && (!nearest.top || topGap < nearest.top.gap)) {
        nearest.top = { gap: topGap, b, at };
      }
      const bottomGap = b.y - (sel.y + sel.h);
      if (bottomGap >= 0 && (!nearest.bottom || bottomGap < nearest.bottom.gap)) {
        nearest.bottom = { gap: bottomGap, b, at };
      }
    }
  }

  /* 世界坐标换成屏幕坐标再画；两头的刻度由 CSS 伪元素补 */
  const ruler = (kind, from, to, gap) => {
    const a = worldToStage(from.x, from.y);
    const c = worldToStage(to.x, to.y);
    const line = document.createElement("div");
    line.className = `canvas-measure-line canvas-measure-${kind}`;
    if (kind === "h") {
      line.style.left = `${Math.min(a.x, c.x)}px`;
      line.style.top = `${a.y}px`;
      line.style.width = `${Math.abs(c.x - a.x)}px`;
    } else {
      line.style.left = `${a.x}px`;
      line.style.top = `${Math.min(a.y, c.y)}px`;
      line.style.height = `${Math.abs(c.y - a.y)}px`;
    }
    const label = document.createElement("span");
    label.className = "canvas-measure-label";
    label.textContent = String(Math.round(gap));
    label.style.left = `${(a.x + c.x) / 2}px`;
    label.style.top = `${(a.y + c.y) / 2}px`;
    layer.append(line, label);
  };

  if (nearest.left) {
    ruler(
      "h",
      { x: nearest.left.b.x + nearest.left.b.w, y: nearest.left.at },
      { x: sel.x, y: nearest.left.at },
      nearest.left.gap,
    );
  }
  if (nearest.right) {
    ruler(
      "h",
      { x: sel.x + sel.w, y: nearest.right.at },
      { x: nearest.right.b.x, y: nearest.right.at },
      nearest.right.gap,
    );
  }
  if (nearest.top) {
    ruler(
      "v",
      { x: nearest.top.at, y: nearest.top.b.y + nearest.top.b.h },
      { x: nearest.top.at, y: sel.y },
      nearest.top.gap,
    );
  }
  if (nearest.bottom) {
    ruler(
      "v",
      { x: nearest.bottom.at, y: sel.y + sel.h },
      { x: nearest.bottom.at, y: nearest.bottom.b.y },
      nearest.bottom.gap,
    );
  }
}

export function startDraw(e) {
  const start = clientToWorld(e.clientX, e.clientY);
  let item = null;
  if (tool === "rect" || tool === "ellipse") item = makeBox(tool, start.x, start.y, start.x, start.y);
  else if (tool === "picture") item = makePicture(start.x, start.y, 0, 0);
  else if (tool === "scene") item = makeScene(start.x, start.y, 0, 0);
  else if (tool === "line" || tool === "arrow") item = makeLine(tool, start.x, start.y, start.x, start.y);
  else if (tool === "text") item = makeText(start.x, start.y, 40);
  if (!item) {
    dropTool();
    return;
  }

  e.preventDefault();
  select(null);
  /* text 块不走 placeBlock，创建这一下自己夹 */
  clampXToPage(item);
  current.items.push(item);
  addItemElement(item);
  setDrag({
    kind: "draw",
    id: item.id,
    start,
    moved: false,
  });
}

export function startResize(handle, e) {
  /* 手柄只在单选时才画出来，所以这里拿到的必然是那一个 */
  const item = findItem(loneSelected());
  if (!item) return;
  const start = clientToWorld(e.clientX, e.clientY);
  if (handle.dataset.handle === "bend") {
    setDrag({
      kind: "bend",
      id: item.id,
      index: Number(handle.dataset.index),
      start,
      moved: false,
    });
    return;
  }
  if (handle.dataset.handle === "connect-end") {
    setDrag({
      kind: "connect-end",
      id: item.id,
      end: handle.dataset.end,
      fixedId: handle.dataset.end === "from" ? item.to.item : item.from.item,
      point: start,
      targetId: null,
    });
    ui.stage.classList.add("is-connecting");
    updatePorts();
    drawConnectPreview();
    return;
  }
  if (handle.dataset.handle === "endpoint") {
    setDrag({
      kind: "endpoint",
      id: item.id,
      end: handle.dataset.end,
      start,
      origin: { ...item },
      moved: false,
    });
    return;
  }
  /* 文字高度由内容撑开，item.h 可能过期；以当前渲染高度为缩放基准 */
  const el = itemEls.get(item.id);
  if (item.type === "text" && el) item.h = el.offsetHeight;
  setDrag({
    kind: "resize",
    id: item.id,
    dir: handle.dataset.dir,
    start,
    origin: { ...item },
    aspect: item.w / Math.max(1, item.h),
    page: capturePagePin(item, el),
    moved: false,
  });
  ui.stage.classList.add("is-resizing");
}

export function onWindowPointerMove(e) {
  if (!active || !drag || !current) return;

  /* 平移用的是屏幕坐标，没有世界坐标起点；先处理，别去读 drag.start */
  if (drag.kind === "marquee") {
    const dx = e.clientX - drag.startClient.x;
    const dy = e.clientY - drag.startClient.y;
    if (!drag.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    drag.moved = true;
    updateMarquee(drag, e.clientX, e.clientY);
    return;
  }

  if (drag.kind === "pan") {
    const dx = e.clientX - drag.startClient.x;
    const dy = e.clientY - drag.startClient.y;
    /* 点一下（手抖一两像素）不算拖视野：没走出死区就一帧都不挪。
       锁定的块按住是拖画布，所以这条在「点锁定面板」时最容易被看到——
       以前按一下就整屏偏几像素，看着像画面在晃。 */
    if (!drag.moved && Math.abs(dx) <= PAN_SLOP_PX && Math.abs(dy) <= PAN_SLOP_PX) return;
    drag.moved = true;
    /* 真拖起来才提升合成层：光按一下不动，提升会触发一次重栅格化，整屏抖一下 */
    ui.stage.classList.add("is-panning");
    /* 走增量：固定宽度下 applyCamera 会把 x 夹在页面附近，若用 origin + 总位移，
       夹住后下一帧又从旧 origin 重算，会把夹掉的部分吐回来（边界处回弹）。
       每帧以「当前已夹过的相机」为基准推进，y 无约束、同样处理无妨。 */
    const stepX = e.clientX - (drag.lastClient ? drag.lastClient.x : drag.startClient.x);
    const stepY = e.clientY - (drag.lastClient ? drag.lastClient.y : drag.startClient.y);
    drag.lastClient = { x: e.clientX, y: e.clientY };
    current.camera.x += stepX;
    current.camera.y += stepY;
    applyCamera();
    return;
  }

  if (drag.kind === "paint") {
    onPaintPointerMove(e);
    return;
  }

  if (drag.kind === "connect" || drag.kind === "connect-end") {
    drag.point = clientToWorld(e.clientX, e.clientY);
    const exclude = drag.kind === "connect" ? [drag.from.item] : [drag.fixedId];
    const hit = connectHit(e, exclude);
    drag.targetSide = hit ? hit.side : null;
    if (setConnectTarget(hit ? hit.id : null)) updatePorts();
    drawConnectPreview();
    return;
  }

  const point = clientToWorld(e.clientX, e.clientY);
  let dx = point.x - drag.start.x;
  let dy = point.y - drag.start.y;
  /* 整块拖动要先走出一点死区才算「真的在拖」：手按下去那零点几像素的抖动
     不能算数，否则按下瞬间就会触发吸附，把块吸到别块边上又弹回来。 */
  const moveSlop = drag.kind === "move" ? MOVE_SLOP_PX / Math.max(0.01, current.camera.scale) : 0.5;
  if (Math.abs(dx) > moveSlop || Math.abs(dy) > moveSlop) drag.moved = true;

  /* 整组挪位：单选就一个成员，多选把选中的都按各自起点平移同样的距离 */
  if (drag.kind === "move") {
    /* 还没走出死区：原地不动，既不吸附也不位移（松手时也就没有「跳一下」可看） */
    if (!drag.moved) {
      drawSnapGuides([]);
      return;
    }
    /* 同上：走出死区才把块提到合成层 */
    ui.stage.classList.add("is-moving");
    let offsetX = dx;
    let offsetY = dy;
    /* Shift 锁一个轴：只沿此刻走得更远的那条轴动，另一轴钉死 */
    let onlyAxis = null;
    if (e.shiftKey) {
      onlyAxis = Math.abs(offsetX) >= Math.abs(offsetY) ? "x" : "y";
      if (onlyAxis === "x") offsetY = 0;
      else offsetX = 0;
    }
    const snapped = snapOffset(drag.group, offsetX, offsetY, onlyAxis);
    /* 固定宽度：整组按外接框夹回页内，再落到各成员的坐标上 */
    snapped.dx = clampGroupDx(drag.group, snapped.dx, true);
    for (const member of drag.group) {
      member.item.x = member.origin.x + snapped.dx;
      member.item.y = member.origin.y + snapped.dy;
      if (member.item.type === "line" || member.item.type === "arrow") {
        member.item.x2 = member.origin.x2 + snapped.dx;
        member.item.y2 = member.origin.y2 + snapped.dy;
      }
      /* 拖动期间不写 left/top（那会重排、重绘整块内容，画面块几万条 SVG 时每帧都在重新栅格化），
         用 transform 平移——只走合成层；松手时再落回 left/top */
      member.el.style.transform = `translate3d(${snapped.dx}px, ${snapped.dy}px, 0)`;
    }
    drawSnapGuides(snapped.guides);
    /* 选中框和端口本来就长在块自己身上，跟着块一起走；每帧只补算连线、坐标和鸟瞰窗。
       走完整的 updateSelection 会把每个框都拆了重建，一次拖几十块就卡。 */
    refreshConnectors();
    updatePorts();
    refreshMinimap();
    scheduleMeasurements();
    return;
  }

  const item = findItem(drag.id);
  if (!item) return;
  const el = itemEls.get(item.id);
  if (!el) return;

  if (drag.kind === "bend-insert") {
    /* 手一抖不算拖：超过 3px 才真插折点 */
    if (Math.hypot(dx, dy) < 3) return;
    const anchor = nearestPathPoint(el, point);
    const geometry = connectorGeometry(item, boundsOfItem);
    if (!anchor || !geometry) return;
    /* 第一次拖线身：先把当前自动折线的拐点原样收下，插折点那一刻形状不跳；
       曲线没有现成拐点，只能从头排 */
    const points = item.points?.length
      ? [...item.points]
      : item.shape === "curve"
        ? []
        : (geometry.vertices || []).slice(1, -1);
    if (points.length >= CONNECTOR_MAX_POINTS) return;
    const index = bendInsertIndex([geometry.a, ...points, geometry.b], anchor);
    points.splice(index, 0, anchor);
    item.points = points;
    drag.moved = true;
    drag.kind = "bend";
    drag.index = index;
    drag.start = { ...anchor };
    syncConnector(item);
    updateSelection();
    return;
  }

  if (drag.kind === "bend") {
    if (!item.points?.[drag.index]) return;
    item.points[drag.index] = { x: point.x, y: point.y };
    syncConnector(item);
    updateSelection();
    return;
  }

  if (drag.kind === "endpoint") {
    /* 拖的是哪一头，另一端就是吸角度的原点 */
    const origin = drag.end === "a" ? { x: item.x2, y: item.y2 } : { x: item.x, y: item.y };
    const snapped = snapLineAngle(origin, point);
    const target = snapped ? snapped.point : point;
    if (drag.end === "a") {
      item.x = target.x;
      item.y = target.y;
    } else {
      item.x2 = target.x;
      item.y2 = target.y;
    }
    drawSnapGuides(snapped ? [snapped.guide] : []);
  } else if (drag.kind === "draw") {
    if (
      item.type === "rect" ||
      item.type === "ellipse" ||
      item.type === "picture" ||
      item.type === "scene"
    ) {
      item.x = Math.min(drag.start.x, point.x);
      item.y = Math.min(drag.start.y, point.y);
      item.w = Math.max(1, Math.abs(dx));
      item.h = Math.max(1, Math.abs(dy));
    } else if (item.type === "line" || item.type === "arrow") {
      /* 画的时候也吸：起点在按下处，鼠标离 45° 的倍数足够近就咬住 */
      const snapped = snapLineAngle({ x: item.x, y: item.y }, point);
      const target = snapped ? snapped.point : point;
      item.x2 = target.x;
      item.y2 = target.y;
      drawSnapGuides(snapped ? [snapped.guide] : []);
    } else if (item.type === "text") {
      /* 文字块拖出矩形：按下处是起点，往右下方拖出宽高 */
      item.x = Math.min(drag.start.x, point.x);
      item.y = Math.min(drag.start.y, point.y);
      item.w = Math.max(40, Math.abs(dx));
      item.minH = Math.max(32, Math.abs(dy));
    }
    /* 从页面外起笔画、或拖出右边界：都把这块收回页内 */
    clampXToPage(item);
  } else if (drag.kind === "resize") {
    const origin = drag.origin;
    const snapped = snapResize(drag, dx, dy);
    dx = snapped.dx;
    dy = snapped.dy;
    if (item.type === "image") {
      if (drag.dir === "n" || drag.dir === "s") {
        /* 上下边拖：以高度为准等比缩放，水平居中，免得图被拉变形 */
        const h = Math.max(8, drag.dir === "n" ? origin.h - dy : origin.h + dy);
        const w = h * drag.aspect;
        item.w = w;
        item.h = h;
        item.x = origin.x + (origin.w - w) / 2;
        item.y = drag.dir === "n" ? origin.y + origin.h - h : origin.y;
      } else {
        const width =
          drag.dir.includes("e") ? origin.w + dx : origin.w - dx;
        const w = Math.max(8, width);
        const h = w / drag.aspect;
        item.w = w;
        item.h = h;
        item.x = drag.dir.includes("w") ? origin.x + origin.w - w : origin.x;
        item.y = drag.dir.includes("n") ? origin.y + origin.h - h : origin.y;
      }
    } else if (item.type === "text") {
      /* 拖角：左右改宽度，上下改最小高度（内容再多仍会自动长高） */
      let w = origin.w;
      if (drag.dir.includes("e")) w = Math.max(40, origin.w + dx);
      if (drag.dir.includes("w")) w = Math.max(40, origin.w - dx);
      item.w = w;
      item.x = drag.dir.includes("w") ? origin.x + origin.w - w : origin.x;

      let h = origin.h;
      if (drag.dir.includes("s")) h = Math.max(32, origin.h + dy);
      if (drag.dir.includes("n")) h = Math.max(32, origin.h - dy);
      item.minH = h;
      item.y = drag.dir.includes("n") ? origin.y + origin.h - h : origin.y;
    } else {
      /* 每类面板拖角的地板：拉到这块自己的最小尺寸就不动了 */
      const min = RESIZE_MIN[item.type] || { w: 8, h: 8 };
      if (drag.dir.includes("e")) item.w = Math.max(min.w, origin.w + dx);
      if (drag.dir.includes("w")) {
        const w = Math.max(min.w, origin.w - dx);
        item.x = origin.x + origin.w - w;
        item.w = w;
      }
      if (drag.dir.includes("s")) item.h = Math.max(min.h, origin.h + dy);
      if (drag.dir.includes("n")) {
        const h = Math.max(min.h, origin.h - dy);
        item.y = origin.y + origin.h - h;
        item.h = h;
      }
      /* 手动拉过就别再自动按视频比例改了（自动改只在第一次拿到元数据时发生） */
      if (item.type === "video") item.sized = true;
    }
    /* 往左拉出页面时把块整体推回来，宽度保持用户拖出来的值 */
    clampXToPage(item);
    drawSnapGuides(snapped.guides);
  }

  /* 书页钉在起始尺寸上，容器的真实尺寸才不会把它撑到掉帧；拉满靠 transform */
  if (drag.page) pinEbookPage(drag.page);
  syncItemElement(el, item);
  /* 生图面板拉过高度：记住这是手动尺寸，提示词超出时在框里滚，不再自动长高。
     这个标记要跟着块存进画布文件——只放 dataset 的话重开画布就丢，面板又会被撑高 */
  if (item.type === "gen") {
    el.dataset.userResized = "1";
    item.manualSize = true;
    fitGenPrompt(item.id, el.querySelector(".canvas-gen-prompt"), false);
  }
  if (drag.page) stretchEbookPage(drag.page);
  if (item.type === "text") {
    item.h = el.offsetHeight;
    /* 内容把块撑得比目标高时，拖上边要贴住底边重算 y */
    if (drag.kind === "resize" && drag.dir.includes("n")) {
      item.y = drag.origin.y + drag.origin.h - item.h;
      syncItemElement(el, item);
    }
  }
  updateSelection();
}

export function onWindowPointerUp(e) {
  settlePointerUp(e);
}

export function settlePointerUp(e) {
  if (!drag || !current) return;
  const finished = drag;
  setDrag(null);
  ui.stage.classList.remove("is-panning", "is-moving", "is-resizing");
  drawSnapGuides([]);
  if (finished.kind === "paint") {
    finishPaint(finished);
    return;
  }
  if (e) {
    const hit = connectHit(e, []);
    if (hit) setHoverId(hit.id);
    /* 以松手瞬间的位置为准，避免最后一次移动事件之后又挪到端口上 */
    if (hit && (finished.kind === "connect" || finished.kind === "connect-end")) {
      const exclude = finished.kind === "connect" ? finished.from.item : finished.fixedId;
      if (hit.id !== exclude) {
        finished.targetId = hit.id;
        finished.targetSide = hit.side;
      }
    }
  }
  updatePorts();
  const item = finished.id ? findItem(finished.id) : null;
  if (finished.page && item) {
    /* 拖拽期间书页只是被「画」成目标大小，松手这一下才真给它换尺寸，正文重新排版 */
    const el = itemEls.get(item.id);
    releaseEbookPage(finished.page);
    if (el) syncItemElement(el, item);
  }

  if (finished.kind === "marquee") {
    finishMarquee(finished);
    return;
  }
  if (finished.kind === "pan") {
    if (finished.moved) scheduleCameraSave();
    return;
  }
  if (finished.kind === "connect") {
    finishConnect(finished);
    return;
  }
  if (finished.kind === "connect-end") {
    finishConnectEnd(finished);
    return;
  }
  if (!item) {
    /* 拖到一半这块没了（切画布/被别处删掉）：手势没有收尾，工具也得自己退回去 */
    dropTool();
    return;
  }

  if (finished.kind === "draw") {
    if (item.type === "text") {
      if (!finished.moved) {
        item.x = finished.start.x;
        item.y = finished.start.y;
        item.w = TEXT_DEFAULT_WIDTH;
        item.minH = TEXT_DEFAULT_WIDTH;
      }
      syncItemElement(itemEls.get(item.id), item);
      setTool("select", true);
      select(item.id);
      scheduleItemsSave();
      startTextEdit(item.id);
      return;
    }
    const tooSmall =
      item.type === "line" || item.type === "arrow"
        ? Math.hypot(item.x2 - item.x, item.y2 - item.y) < 3
        : item.type === "picture"
          ? item.w < PICTURE_MIN_WIDTH || item.h < PICTURE_MIN_HEIGHT
          : item.w < 4 || item.h < 4;
    if (!finished.moved || tooSmall) {
      removeItemFromDom(item.id);
      const index = current.items.indexOf(item);
      if (index >= 0) current.items.splice(index, 1);
      select(null);
      setTool("select");
      return;
    }
    setTool("select", true);
    select(item.id);
    /* 画面块拖得太小不回收，给个能画的地板：它是拿来画东西的，不是装饰 */
    if (item.type === "picture") {
      item.w = Math.max(PICTURE_MIN_WIDTH, item.w);
      item.h = Math.max(PICTURE_MIN_HEIGHT, item.h);
      syncItemElement(itemEls.get(item.id), item);
    }
    /* 场景块同理：拖出多大都先给一块能看的视口，太小的地板交给这里，
       不交给上面的 tooSmall——那条是「根本没拖动就别留」的判据，不是尺寸地板 */
    if (item.type === "scene") {
      item.w = Math.max(SCENE_MIN_WIDTH, item.w);
      item.h = Math.max(SCENE_MIN_HEIGHT, item.h);
      syncItemElement(itemEls.get(item.id), item);
    }
    /* 生图面板同理：地板是给上面那块取景窗留的，再小就没法看正在长的图 */
    if (item.type === "gen") {
      item.w = Math.max(GEN_MIN_WIDTH, item.w);
      item.h = Math.max(GEN_MIN_HEIGHT, item.h);
      syncItemElement(itemEls.get(item.id), item);
    }
    scheduleItemsSave();
    return;
  }

  /* 只是点了一下（没走出死区）：把可能残留的拖影一起擦掉，块留在原地 */
  if (!finished.moved && finished.kind === "move" && finished.group) {
    for (const member of finished.group) {
      if (member.el) member.el.style.transform = "";
    }
  }
  if (!finished.moved) return;
  /* 拖动期间的 transform 偏移在这里落回 left/top */
  if (finished.kind === "move" && finished.group) {
    for (const member of finished.group) {
      if (!member.el) continue;
      member.el.style.transform = "";
      syncItemElement(member.el, member.item);
    }
  }
  /* 拖完重算这几块的容器归属：拖出就脱组、拖进就入组，重叠区各认各的 */
  if (finished.kind === "move" && finished.group) {
    reassignContainerOwners(finished.group.map((member) => member.item));
  } else if (finished.kind === "resize") {
    reassignContainerOwners([item]);
  }
  scheduleItemsSave();
}
