/* 空间后端调用：每个空间都是数据文件夹下 spaces/ 里的一个文件夹。 */

const { invoke, convertFileSrc } = window.__TAURI__.core;

export const listCanvases = () => invoke("canvas_list");
export const createCanvas = (name) => invoke("canvas_create", { name });
export const openCanvas = (id) => invoke("canvas_open", { id });
export const saveCanvasItems = (id, items) => invoke("canvas_save_items", { id, items });
export const saveCanvasCamera = (id, camera) => invoke("canvas_save_camera", { id, camera });
/* 这个空间「复制的连接线属性」，跟着 space.json 走；没复制过时传 null */
export const saveConnectorPreset = (id, preset) =>
  invoke("canvas_save_connector", { id, connector: preset });
export const renameCanvas = (id, name) => invoke("canvas_rename", { id, name });
export const deleteCanvas = (id) => invoke("canvas_delete", { id });
export const saveCanvasImage = (id, data, ext) => invoke("canvas_save_image", { id, data, ext });
/* 图片和音频都不走 base64：后端确认文件还在、开一次 asset 读权限，这里换成地址。
   拷贝态 src 是空间目录里的相对路径，引用态是原文件绝对路径。 */
export const pickCanvasImage = () => invoke("canvas_pick_image");
export const importCanvasImage = (id, path) => invoke("canvas_import_image", { id, path });
export const imageUrl = async (id, src, linked) =>
  convertFileSrc(await invoke("canvas_image_url", { id, src, linked: Boolean(linked) }));
export const deleteCanvasImage = (id, src, linked) =>
  invoke("canvas_delete_image", { id, src, linked: Boolean(linked) });
export const saveCanvasAudio = (id, data, ext) => invoke("canvas_save_audio", { id, data, ext });
export const pickCanvasAudio = () => invoke("canvas_pick_audio");
export const importCanvasAudio = (id, path) => invoke("canvas_import_audio", { id, path });
export const audioUrl = async (id, src, linked) =>
  convertFileSrc(await invoke("canvas_audio_url", { id, src, linked: Boolean(linked) }));
export const deleteCanvasAudio = (id, src, linked) =>
  invoke("canvas_delete_audio", { id, src, linked: Boolean(linked) });
export const videoInfo = (path) => invoke("canvas_video_info", { path });
export const pickCanvasVideo = () => invoke("canvas_pick_video");
export const copyCanvasVideo = (id, path) => invoke("canvas_copy_video", { id, path });
export const cancelVideoCopy = (job) => invoke("canvas_cancel_video_copy", { job });
/* 视频不走 base64：后端只开读权限并给出绝对路径，这里换成 asset 地址，
   <video> 会按 Range 一段段要，20GB 的片子也不会整份进内存。 */
export const videoUrl = async (id, src, linked) =>
  convertFileSrc(await invoke("canvas_video_url", { id, src, linked }));
export const deleteCanvasVideo = (id, src, linked, audioRel) =>
  invoke("canvas_delete_video", { id, src, linked, audioRel: audioRel || null });
/* 文件块：图片/音频/视频之外的都算文件。插的时候问一句——
   拷贝态进空间 files/，引用态只记原文件绝对路径，打开都交给系统默认程序。 */
export const fileInfo = (path) => invoke("canvas_file_info", { path });
export const pickCanvasFile = () => invoke("canvas_pick_file");
export const importCanvasFile = (id, path) => invoke("canvas_import_file", { id, path });
export const copyCanvasFile = (id, path) => invoke("canvas_copy_file", { id, path });
/* .md 抄正文进笔记块，或引用态每次现读 */
export const readFileText = (path) => invoke("canvas_file_text", { path });
export const previewCanvasFile = (id, rel, linked) =>
  invoke("canvas_file_preview", { id, rel, linked: Boolean(linked) });
/* PDF 块：整份不进内存，后端开一次 asset 读权限给出地址，pdf.js 按 Range 一段段要 */
export const fileUrl = async (id, src, linked) =>
  convertFileSrc(await invoke("canvas_file_url", { id, src, linked: Boolean(linked) }));
/* 块内编辑文本文件：读整份、写回整份。路径后端自己从 items.json 那块查，
   这里只给块 id；stamp 是编辑前那份文件的 mtime+大小，写回时拿它判断有没有被外部改过。 */
export const readFileBody = (id, itemId) => invoke("canvas_file_body", { id, itemId });
export const writeBackCanvasFile = (id, itemId, text, body, force) =>
  invoke("canvas_file_write_back", {
    id,
    itemId,
    text,
    format: body.format,
    crlf: Boolean(body.crlf),
    stamp: body.stamp || "",
    force: Boolean(force),
  });
export const revealCanvasFile = (id, rel, linked) =>
  invoke("canvas_reveal_file", { id, rel, linked: Boolean(linked) });
export const deleteCanvasFile = (id, rel, linked) =>
  invoke("canvas_delete_file", { id, rel, linked: Boolean(linked) });
/* 便签块 / 空间自己的笔记块：要显示的是它那份内容文件，路径由后端按块 id 从 items.json 认 */
export const revealBlock = (id, itemId) => invoke("canvas_reveal_block", { id, itemId });
export const canvasFileExists = (id, rel, linked) =>
  invoke("canvas_file_exists", { id, rel, linked: Boolean(linked) });
/* 电子书：放上空间前先整本读一遍目录，读不了的（DRM/KF8）当场说清楚 */
export const ebookInfo = (path) => invoke("canvas_ebook_info", { path });
export const ebookToc = (id, rel, linked) =>
  invoke("canvas_ebook_toc", { id, rel, linked: Boolean(linked) });
export const ebookChapter = (id, rel, linked, index) =>
  invoke("canvas_ebook_chapter", { id, rel, linked: Boolean(linked), index });
/* 引用态笔记块写回原 .md：路径由后端从 items.json 里那块自己查，前端只给块 id */
export const writeBackNote = (id, itemId, text) =>
  invoke("canvas_note_write_back", { id, itemId, text });
/* 探测和音轨兜底：ffmpeg 在不在、片子什么编码、把音轨转成 AAC。 */
export const ffmpegStatus = () => invoke("ffmpeg_status");
export const revealFfmpegDir = () => invoke("ffmpeg_reveal");
export const probeVideo = (id, src, linked) => invoke("canvas_video_probe", { id, src, linked });
export const fixVideoAudio = (id, src, linked) => invoke("canvas_audio_fix", { id, src, linked });
export const saveCanvasNoteImage = (id, itemId, data, ext) =>
  invoke("canvas_save_note_image", { id, itemId, data, ext });
export const readCanvasNoteImage = (id, itemId, rel) =>
  invoke("canvas_read_note_image", { id, itemId, rel });
/* 空间自己的便签/笔记：一块一份文件，住在 <空间>/stickies、<空间>/notes 里。 */
export const readSticky = (id, itemId) => invoke("canvas_read_sticky", { id, itemId });
export const writeSticky = (id, itemId, sticky) => invoke("canvas_write_sticky", { id, itemId, sticky });
export const duplicateSticky = (id, itemId, toId, toItem) =>
  invoke("canvas_duplicate_sticky", { id, itemId, toId, toItem });
export const deleteSticky = (id, itemId) => invoke("canvas_delete_sticky", { id, itemId });
export const readNoteText = (id, itemId) => invoke("canvas_read_note", { id, itemId });
export const writeNoteText = (id, itemId, text) => invoke("canvas_write_note", { id, itemId, text });
export const duplicateNote = (id, itemId, toId, toItem) =>
  invoke("canvas_duplicate_note", { id, itemId, toId, toItem });
export const deleteNote = (id, itemId) => invoke("canvas_delete_note", { id, itemId });
/* 复制块时把源块那份文件再拷一份进目标空间，返回新的相对路径；
   引用态那块也照样收：从它记的原文件路径拷，粘出来的块从此自己带一份 */
export const duplicateMedia = (id, itemId, toId) =>
  invoke("canvas_duplicate_media", { id, itemId, toId });
export const readNote = (rel) => invoke("notes_read", { rel });
export const readNoteImage = (noteRel, rel) => invoke("notes_read_image", { noteRel, rel });
export const listNotes = () => invoke("notes_tree");
export const revealCanvas = (id) => invoke("canvas_reveal", { id });
