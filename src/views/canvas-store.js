/* 画布后端调用：每个画布都是数据文件夹下 spaces/ 里的一个文件夹。 */

const { invoke, convertFileSrc } = window.__TAURI__.core;

export const listCanvases = () => invoke("canvas_list");
export const createCanvas = (name) => invoke("canvas_create", { name });
export const openCanvas = (id) => invoke("canvas_open", { id });
export const saveCanvasItems = (id, items) => invoke("canvas_save_items", { id, items });
export const saveCanvasCamera = (id, camera) => invoke("canvas_save_camera", { id, camera });
export const renameCanvas = (id, name) => invoke("canvas_rename", { id, name });
export const deleteCanvas = (id) => invoke("canvas_delete", { id });
export const saveCanvasImage = (id, data, ext) => invoke("canvas_save_image", { id, data, ext });
/* 图片和音频都不走 base64：后端确认文件还在、开一次 asset 读权限，这里换成地址。
   拷贝态 src 是画布目录里的相对路径，引用态是原文件绝对路径。 */
export const pickCanvasImage = () => invoke("canvas_pick_image");
export const importCanvasImage = (id, path) => invoke("canvas_import_image", { id, path });
export const imageUrl = async (id, src, linked) =>
  convertFileSrc(await invoke("canvas_image_url", { id, src, linked: Boolean(linked) }));
/* 双击看大图：交给系统默认的看图工具打开那块图。路径后端从 items.json 那块自己算，
   前端只给块 id。 */
export const openCanvasImage = (id, itemId) =>
  invoke("canvas_open_image", { id, itemId });
/* 删图：文件当场进系统回收站，引用态的原图不碰。 */
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
   拷贝态进画布 files/，引用态只记原文件绝对路径，打开都交给系统默认程序。 */
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
/* 画布自己的笔记块：要显示的是它那份内容文件，路径由后端按块 id 从 items.json 认 */
export const revealBlock = (id, itemId) => invoke("canvas_reveal_block", { id, itemId });
export const canvasFileExists = (id, rel, linked) =>
  invoke("canvas_file_exists", { id, rel, linked: Boolean(linked) });
/* 电子书：放上画布前先整本读一遍目录，读不了的（DRM/KF8）当场说清楚 */
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
/* 画布自己的笔记：一块一份文件，住在 <画布>/notes 里。 */
export const readNoteText = (id, itemId) => invoke("canvas_read_note", { id, itemId });
export const writeNoteText = (id, itemId, text) => invoke("canvas_write_note", { id, itemId, text });
export const duplicateNote = (id, itemId, toId, toItem) =>
  invoke("canvas_duplicate_note", { id, itemId, toId, toItem });
export const deleteNote = (id, itemId) => invoke("canvas_delete_note", { id, itemId });
/* 画面块的绘制指令和素材表一块一份，住在 <画布>/pictures/<块id>.json：
   手绘一笔就上百个点，塞进 items.json 会把整个画布的读写一起拖慢。 */
export const readPicture = (id, itemId) => invoke("canvas_read_picture", { id, itemId });
export const writePicture = (id, itemId, cmds, symbols) =>
  invoke("canvas_write_picture", { id, itemId, cmds, symbols: symbols || {} });
export const deletePicture = (id, itemId) => invoke("canvas_delete_picture", { id, itemId });
/* 场景块里的东西一块一份，住在 <画布>/scenes/<块id>.json：
   一件东西动辄上百个坐标点，塞进 items.json 会把整个画布的读写和每份快照一起拖慢。 */
export const readScene = (id, itemId) => invoke("canvas_read_scene", { id, itemId });
export const writeScene = (id, itemId, parts) =>
  invoke("canvas_write_scene", { id, itemId, parts: parts || [] });
export const deleteScene = (id, itemId) => invoke("canvas_delete_scene", { id, itemId });
/* 生图面板的提示词和参数，一块一份，住在 <画布>/genpanels/<块id>.json。
   出的那张图不在这里——它落在 images/ 里，路径记在块上，和图片块同一套规矩。 */
export const readGen = (id, itemId) => invoke("canvas_read_gen", { id, itemId });
export const writeGen = (id, itemId, content) => invoke("canvas_write_gen", { id, itemId, content });
export const deleteGen = (id, itemId) => invoke("canvas_delete_gen", { id, itemId });
/* 出图引擎：一次只出一张，进度和成品走事件（gen-progress / gen-preview / gen-done / gen-failed） */
export const genStatus = () => invoke("gen_status");
export const genStart = (req) => invoke("gen_start", { req });
export const genCancel = () => invoke("gen_cancel");
/* 复制块时把源块那份文件再拷一份进目标画布，返回新的相对路径；
   引用态那块也照样收：从它记的原文件路径拷，粘出来的块从此自己带一份 */
export const duplicateMedia = (id, itemId, toId) =>
  invoke("canvas_duplicate_media", { id, itemId, toId });
/* 画面块垫的位图：items.json 里没有它的记录，src 只能由前端从指令里读出来直给，
   后端仍旧只认源画布 images/ 以内（或引用态那个原文件绝对路径）。 */
export const duplicatePictureImage = (id, src, linked, toId) =>
  invoke("canvas_duplicate_picture_image", { id, src, linked: Boolean(linked), toId });
export const revealCanvas = (id) => invoke("canvas_reveal", { id });
/* 导出：图片块先读成 data URL 再进导出图（asset 协议是另一个源，直接画会污染画布）；
   拼好的 PNG / PDF 交给后端弹保存框写盘，取消返回 null。 */
export const imageData = (id, src, linked) =>
  invoke("canvas_image_data", { id, src, linked: Boolean(linked) });
export const exportSave = (name, ext, data) => invoke("canvas_export_save", { name, ext, data });
export const openExport = (path) => invoke("canvas_open_export", { path });
/* 分段导出：先选一次文件夹，之后一张一张写进去，不弹 N 个保存框 */
export const exportPickDir = () => invoke("canvas_export_pick_dir");
export const exportWrite = (dir, name, ext, data) =>
  invoke("canvas_export_write", { dir, name, ext, data });
/* 跨画布搜索：后端把所有画布的 items.json 扫一遍，只认块里的文字 */
export const searchSpace = (query) => invoke("canvas_search", { query });
