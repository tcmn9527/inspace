/* 从 canvas.js 拆出：content-files */

import { GEN_CFG_MAX, GEN_MODES, GEN_STEPS_MAX, PICTURE_MAX_CMDS, current, findItem, normalizePictureCmds, normalizePictureSymbols, normalizeSceneParts, showError, snapGenSize, store } from "../canvas.js";

/* ---------- 笔记 / 画面块的内容文件 ----------
   一块一份，住在画布自己目录里：笔记 notes/<块id>.md，画面 pictures/<块id>.json。
   items.json 只留位置和层级，正文和笔画不再内嵌。 */

export const CONTENT_WRITE_DELAY = 400;
export let noteTimers = new Map();
export let pictureTimers = new Map();
export let sceneTimers = new Map();
export let genTimers = new Map();
export function scheduleContentWrite(timers, key, write) {
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      write();
    }, CONTENT_WRITE_DELAY),
  );
}

export function persistNote(item) {
  if (!current || item.type !== "note" || item.linked) return;
  const canvasId = current.meta.id;
  scheduleContentWrite(noteTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target || target.linked) return;
    store.writeNoteText(canvasId, item.id, target.source || "").catch(showError);
  });
}

/* 画面的指令和素材表只认 pictures/<块id>.json 那一份：items.json 里没有它们，
   块自己的笔画撤销管的是画笔那层栈，和这儿无关。 */
export function persistPicture(item) {
  if (!current || item.type !== "picture") return;
  const canvasId = current.meta.id;
  scheduleContentWrite(pictureTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target) return;
    store.writePicture(canvasId, item.id, target.cmds || [], target.symbols || {}).catch(showError);
  });
}

/* 场景块里的东西只认 scenes/<块id>.json 那一份：items.json 里没有 parts。 */
export function persistScene(item) {
  if (!current || item.type !== "scene") return;
  const canvasId = current.meta.id;
  scheduleContentWrite(sceneTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target) return;
    store.writeScene(canvasId, item.id, target.parts || []).catch(showError);
  });
}

/* 面板写的那句话和那几个参数只认 genpanels/<块id>.json 那一份；
   出的那张图不在这一份里：它和 img 块一样是 images/ 里的真文件，路径记在块上。 */
export function persistGen(item) {
  if (!current || item.type !== "gen") return;
  const canvasId = current.meta.id;
  scheduleContentWrite(genTimers, item.id, () => {
    const target = current && current.meta.id === canvasId ? findItem(item.id) : null;
    if (!target) return;
    store.writeGen(canvasId, item.id, genContentOf(target)).catch(showError);
  });
}

export function genContentOf(item) {
  return {
    prompt: item.prompt || "",
    negative: item.negative || "",
    imageW: item.imageW,
    imageH: item.imageH,
    steps: item.steps,
    cfg: item.cfg,
    seed: item.seed,
    mode: item.mode,
    model: item.model || "",
    strength: item.strength,
  };
}

/* 切画布、重命名、退出页面前把还没写完的正文补上，最后一次编辑不至于丢掉 */
export async function flushBlockContents() {
  const canvasId = current?.meta.id;
  const pending = [
    ...[...noteTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, kind: "note" })),
    ...[...pictureTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, kind: "picture" })),
    ...[...sceneTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, kind: "scene" })),
    ...[...genTimers.entries()].map(([itemId, timer]) => ({ timer, itemId, kind: "gen" })),
  ];
  noteTimers.clear();
  pictureTimers.clear();
  sceneTimers.clear();
  genTimers.clear();
  if (!canvasId) return;
  await Promise.all(
    pending.map(({ timer, itemId, kind }) => {
      clearTimeout(timer);
      const item = findItem(itemId);
      if (!item) return null;
      if (kind === "note") return store.writeNoteText(canvasId, itemId, item.source || "").catch(showError);
      if (kind === "picture")
        return store.writePicture(canvasId, itemId, item.cmds || [], item.symbols || {}).catch(showError);
      if (kind === "gen") return store.writeGen(canvasId, itemId, genContentOf(item)).catch(showError);
      return store.writeScene(canvasId, itemId, item.parts || []).catch(showError);
    }),
  );
}

/* 读每块自己的文件当正文；文件还没落过盘的老数据，拿块里残留的正文补写一次。
   读不动的那几块交给丢文件卡，别拿空白糊弄用户。 */
export async function loadBlockContents() {
  if (!current) return [];
  const canvasId = current.meta.id;
  const broken = [];
  await Promise.all(
    current.items
      .filter(
        (item) =>
          (item.type === "note" && !item.linked) ||
          item.type === "picture" ||
          item.type === "scene" ||
          item.type === "gen",
      )
      .map(async (item) => {
        try {
          if (item.type === "picture") {
            /* 老数据把指令记在 items.json 的块上，块里还留着：读不到文件就补写一份，
               下一次 items.json 落盘自然把它们清出去 */
            const file = await store.readPicture(canvasId, item.id);
            if (file) {
              /* 素材表先归一化：use 和 tile 漆都靠它才知道名字在不在，
                 认不了的整条丢，和 cmds 一个规矩 */
              item.symbols = normalizePictureSymbols(file.symbols).symbols;
              item.cmds = normalizePictureCmds(file.cmds, PICTURE_MAX_CMDS, { symbols: item.symbols }).cmds;
            } else {
              await store.writePicture(canvasId, item.id, item.cmds || [], item.symbols || {});
            }
            return;
          }
          if (item.type === "scene") {
            /* 老数据把东西记在 items.json 的块上，块里还留着：读不到文件就补写一份，
               下一次 items.json 落盘自然把它们清出去 */
            const file = await store.readScene(canvasId, item.id);
            if (file) {
              /* 盘上那份照样过一遍归一化：手改坏的文件里认不了的那件整件丢，
                 和建块、改块是同一套规矩，不给渲染器递畸形几何 */
              item.parts = normalizeSceneParts(file.parts).parts;
            } else {
              await store.writeScene(canvasId, item.id, item.parts || []);
            }
            return;
          }
          if (item.type === "gen") {
            /* 提示词和参数只认这一份文件：读不到就按块上现在那份补写一次 */
            const file = await store.readGen(canvasId, item.id);
            if (file) {
              item.prompt = file.prompt;
              item.negative = file.negative;
              item.imageW = snapGenSize(file.imageW);
              item.imageH = snapGenSize(file.imageH);
              item.steps = Math.min(GEN_STEPS_MAX, Math.max(0, file.steps));
              item.cfg = Math.min(GEN_CFG_MAX, Math.max(0, file.cfg));
              item.seed = Number.isFinite(file.seed) && file.seed >= -1 ? Math.trunc(file.seed) : -1;
              /* 老文件里没有这两个字段：按「看连线自己定」和上游默认改动幅度接上 */
              item.mode = GEN_MODES.includes(file.mode) ? file.mode : "auto";
              item.model = file.model === "qwen21" || file.model === "h3image" ? file.model : "";
              item.strength = Number.isFinite(file.strength)
                ? Math.min(1, Math.max(0, file.strength))
                : item.strength;
            } else {
              await store.writeGen(canvasId, item.id, genContentOf(item));
            }
            return;
          }
          const text = await store.readNoteText(canvasId, item.id);
          if (text === null || text === undefined) {
            await store.writeNoteText(canvasId, item.id, item.source || "");
            return;
          }
          item.source = text;
        } catch {
          broken.push(item);
        }
      }),
  );
  return broken;
}
