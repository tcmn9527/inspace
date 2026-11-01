/* 撤销栈。
 *
 * 存的是整张画布的快照（一串字符串），不是补丁：块的结构本来就小，比对和回放都比
 * 维护一套 patch 简单，也不会出现「撤销到一半数据对不上」的中间态。
 *
 * 三个约定：
 *   1. touch() 只是「可能有变化了」，真正落栈要等一小段时间没新动静 —— 一次拖动、
 *      一串连打都只算一步，不会把每个 pointermove 都记成一笔。
 *   2. 快照和上一份完全一样就不入栈，所以点一下、选一下不会制造空步骤。
 *   3. 删块时那些要跟着回收的文件（图片副本、便签 json…）先不删，作为 cleanup 挂在
 *      这一笔记录上；等这条记录被挤出撤销栈（再也撤不回来了）才真正执行。撤销一条
 *      删块记录时文件还在，块能连内容一起还回来。
 */

export function createHistory({ capture, apply, limit = 80, delay = 420, onChange } = {}) {
  /* entries[i] = { snap, cleanups: [] }；index 指向「当前状态」那一份 */
  const entries = [];
  let index = -1;
  let timer = 0;
  let pendingCleanups = [];
  let held = false;
  let applying = false;

  const notify = () => {
    onChange?.({
      canUndo: index > 0,
      canRedo: index > -1 && index < entries.length - 1,
    });
  };

  const runCleanups = (entry) => {
    const list = entry?.cleanups;
    if (!list?.length) return;
    entry.cleanups = [];
    for (const cleanup of list) {
      try {
        cleanup();
      } catch {
        /* 清理失败不该影响用户操作：文件留在原地也就是多占点地方 */
      }
    }
  };

  /* 更靠后的那几份快照再也回不去了，它们身上的清理可以兑现 */
  const truncateAfter = (at) => {
    while (entries.length > at + 1) runCleanups(entries.pop());
  };

  function reset() {
    clearTimeout(timer);
    timer = 0;
    pendingCleanups = [];
    held = false;
    applying = false;
    entries.length = 0;
    entries.push({ snap: capture?.() ?? "", cleanups: [] });
    index = 0;
    notify();
  }

  function commit() {
    if (applying) return;
    clearTimeout(timer);
    timer = 0;
    if (index < 0) return;
    let snap;
    try {
      snap = capture?.() ?? "";
    } catch {
      return;
    }
    if (snap === entries[index].snap && !pendingCleanups.length) return;
    truncateAfter(index);
    entries.push({ snap, cleanups: pendingCleanups });
    pendingCleanups = [];
    index += 1;
    while (entries.length > limit) {
      runCleanups(entries.shift());
      index -= 1;
    }
    if (index < 0) index = 0;
    notify();
  }

  /* 有变化：攒一攒再落栈。拖动途中被 hold 住时只记一个「欠着一笔」的标记 */
  function touch() {
    if (applying || index < 0) return;
    if (held) return;
    clearTimeout(timer);
    timer = setTimeout(commit, delay);
  }

  /* 拖动、连续输入这类操作：按住的时候不要在中途落栈，松手再落一次 */
  function hold(on) {
    if (on) {
      held = true;
      clearTimeout(timer);
      timer = 0;
      return;
    }
    if (!held) return;
    held = false;
    commit();
  }

  /* 这一笔要回收的文件；真正执行推迟到这条记录被挤掉的时候 */
  function addCleanup(fn) {
    if (typeof fn === "function") pendingCleanups.push(fn);
  }

  function undo() {
    commit();
    if (index <= 0) return false;
    index -= 1;
    applying = true;
    try {
      apply?.(entries[index].snap);
    } finally {
      applying = false;
    }
    notify();
    return true;
  }

  function redo() {
    commit();
    if (index >= entries.length - 1) return false;
    index += 1;
    applying = true;
    try {
      apply?.(entries[index].snap);
    } finally {
      applying = false;
    }
    notify();
    return true;
  }

  /* 离开空间：撤销记录跟着作废，挂在上面还没兑现的清理一律不执行 ——
     宁可留几个没人引用的文件，也不能删掉正在用的东西 */
  function dispose() {
    clearTimeout(timer);
    timer = 0;
    entries.length = 0;
    pendingCleanups = [];
    index = -1;
    held = false;
    notify();
  }

  return {
    reset,
    touch,
    hold,
    commit,
    addCleanup,
    undo,
    redo,
    dispose,
    get busy() {
      return applying;
    },
    get canUndo() {
      return index > 0;
    },
    get canRedo() {
      return index > -1 && index < entries.length - 1;
    },
  };
}
