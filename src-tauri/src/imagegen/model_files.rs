use super::*;
use super::pipeline::on_log;

pub fn init(data: DataRoot, db: &DbState) -> GenState {
    let core = GenCore {
        data,
        engine: Arc::new(Mutex::new(Engine {
            ctx: null_mut(),
            busy: false,
            block: String::new(),
            last_used: Instant::now(),
            device: read_device(db),
        })),
        cancel: Arc::new(AtomicBool::new(false)),
        family: Arc::new(Mutex::new(read_family(db))),
        picked: Arc::new(Mutex::new([
            read_weights(db, Family::Qwen21),
            read_weights(db, Family::H3Image),
        ])),
        models_dir: Arc::new(Mutex::new([
            read_models_dir(db, Family::Qwen21),
            read_models_dir(db, Family::H3Image),
        ])),
        defaults: Arc::new(Mutex::new([
            read_defaults(db, Family::Qwen21),
            read_defaults(db, Family::H3Image),
        ])),
        gpu: Arc::new(Mutex::new(None)),
        api: Arc::new(Mutex::new(imageapi::load(db))),
        api_jobs: Arc::new(Mutex::new(HashMap::new())),
    };
    // 引擎自己的日志：只放行警告和错误，INFO 一步刷几十行会把开发台埋了
    unsafe {
        sd::sd_set_log_callback(Some(on_log), null_mut());
    }
    // 空闲放权重：不是一条命令能办的事，得有个一直在旁边看的线程
    {
        let watcher = core.clone();
        thread::spawn(move || loop {
            thread::sleep(IDLE_POLL);
            let mut engine = watcher.lock();
            if engine.busy || engine.ctx.is_null() {
                continue;
            }
            if engine.last_used.elapsed() < Duration::from_secs(watcher.family().idle_seconds()) {
                continue;
            }
            unsafe { sd::free_sd_ctx(engine.ctx) };
            engine.ctx = null_mut();
        });
    }
    GenState(core)
}

/// 启动时把「用哪一族」读回来。读不到或值不合法就回到 Qwen——
/// 那是原来一直在跑的那套，升级后行为不变。
fn read_device(db: &DbState) -> String {
    let Ok(conn) = db.0.lock() else { return "gpu".into() };
    match db::read_setting(&conn, "gen_device").as_deref() {
        Some("cpu") => "cpu".into(),
        _ => "gpu".into(),
    }
}

fn read_family(db: &DbState) -> Family {
    let Some(conn) = db.0.lock().ok() else {
        return Family::Qwen21;
    };
    db::read_setting(&conn, FAMILY_KEY)
        .and_then(|text| Family::from_id(&text))
        .unwrap_or(Family::Qwen21)
}

/// 启动时把档位从 SQLite 读回来。读不到、值不合法就用该族的默认档。
/// 这儿不查文件在不在：缺权重是点「开始」那一刻要报的事，不是启动的事。
fn read_weights(db: &DbState, family: Family) -> Weights {
    let mut next = family.defaults();
    let Some(conn) = db.0.lock().ok() else {
        return next;
    };
    for (key, slot) in [
        (family.dit_key(), &mut next.dit),
        (family.encoder_key(), &mut next.encoder),
    ] {
        if let Some(name) = db::read_setting(&conn, key).filter(|name| check_weight_name(name).is_ok())
        {
            *slot = name;
        }
    }
    next
}

/// 另指过的模型目录。空串、不存在的目录都当没配过——跟着数据根走。
/// 用户后来把那个文件夹删了不该让整个生图通路哑掉，退回默认才是能用的样子。
fn read_models_dir(db: &DbState, family: Family) -> Option<PathBuf> {
    let conn = db.0.lock().ok()?;
    let text = db::read_setting(&conn, family.dir_key())?;
    let path = PathBuf::from(text);
    path.is_dir().then_some(path)
}

/// 每族的新建面板默认参数。没存过、存坏了都回出厂值——
/// 参数坏了不该把生图通路的默认挡住。
fn read_defaults(db: &DbState, family: Family) -> GenDefaults {
    let Some(conn) = db.0.lock().ok() else {
        return family.factory_defaults();
    };
    let Some(text) = db::read_setting(&conn, family.defaults_key()) else {
        return family.factory_defaults();
    };
    serde_json::from_str::<GenDefaults>(&text)
        .map(|value| normalize_defaults(value, family))
        .unwrap_or_else(|_| family.factory_defaults())
}

/// 档名只许是 models 目录里的纯文件名：挡掉分隔符、`..`、绝对路径、隐藏文件。
fn check_weight_name(name: &str) -> Result<(), String> {    if name.is_empty() || name.len() > 200 {
        return Err("模型文件名不对".to_string());
    }
    if name.starts_with('.') || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("“{name}”不是个文件名"));
    }
    Ok(())
}

#[tauri::command]
pub fn gen_device_get(state: tauri::State<GenState>) -> String {
    state.0.lock().device.clone()
}

/// 换运行设备：gpu=显卡(快)，cpu=全内存(慢,显存不够时用)。换设备放掉旧 ctx。
#[tauri::command]
pub fn gen_device_set(
    app: tauri::AppHandle,
    state: tauri::State<GenState>,
    device: String,
) -> Result<String, String> {
    let next = if device == "cpu" { "cpu" } else { "gpu" };
    let mut engine = state.0.lock();
    if engine.busy {
        return Err("正在出图，等这一张跑完再换运行设备".to_string());
    }
    {
        let db = app.state::<DbState>();
        let conn = db
            .0
            .lock()
            .map_err(|_| "数据库连接状态异常".to_string())?;
        db::write_setting(&conn, "gen_device", next)?;
    }
    if engine.device != next {
        engine.device = next.to_string();
        if !engine.ctx.is_null() {
            unsafe { sd::free_sd_ctx(engine.ctx) };
            engine.ctx = null_mut();
        }
    }
    Ok(next.to_string())
}

#[tauri::command]
pub fn gen_status(state: tauri::State<GenState>) -> GenStatus {
    let core = state.0.clone();
    /* 锁被「载入权重」占着的时候不能等：等就是卡界面。占着就说明这一轮正在起。 */
    let engine = core.engine.try_lock();
    let (loaded, busy) = match &engine {
        Ok(engine) => (!engine.ctx.is_null(), engine.busy),
        Err(_) => (false, true),
    };
    drop(engine);
    /* API 并行也算「在出图」：本地引擎空着但远端还有任务在跑 */
    let busy = busy
        || core
            .api_jobs
            .lock()
            .map(|jobs| !jobs.is_empty())
            .unwrap_or(true);
    let family = core.family();
    let weights = resolve_weights(&core.models(), family, &core.weights());
    let api = core.api();
    GenStatus {
        loaded,
        busy,
        family: family.id(),
        family_label: family.label(),
        models_dir: core.models().display().to_string(),
        dir_is_default: core.is_default_dir(),
        missing: missing_weights(&core.models(), &weights, family),
        idle_seconds: family.idle_seconds(),
        dit: weights.dit,
        encoder: weights.encoder,
        defaults: core.defaults(),
        provider: if api.enabled { "api" } else { "local" },
        api_model: if api.enabled { api.model.clone() } else { String::new() },
        api_problem: if api.enabled { api.problem() } else { None },
    }
}

/// 换模型族：Qwen-Image 2.1 ↔ MiniMax-H3-Image。正在出图时不换。
/// 换完把旧 ctx 放掉——它是按上一族的权重建的，留着只会让下一张用错模型。
#[tauri::command]
pub async fn gen_family_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, GenState>,
    family: String,
) -> Result<GenModels, String> {
    let core = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || apply_family(core, app, &family))
        .await
        .map_err(|e| format!("换模型任务起不来：{e}"))?
}

pub(super) fn apply_family(core: GenCore, app: tauri::AppHandle, family: &str) -> Result<GenModels, String> {
    let db = app.state::<DbState>();
    let next = Family::from_id(family).ok_or_else(|| format!("没有这个模型：{family}"))?;
    if core.family() == next {
        return Ok(collect_models(&core));
    }
    let mut engine = core.lock();
    if engine.busy {
        return Err("正在出图，等这一张跑完再换模型".to_string());
    }
    {
        let conn = db
            .0
            .lock()
            .map_err(|_| "数据库连接状态异常（前一次访问发生 panic）".to_string())?;
        db::write_setting(&conn, FAMILY_KEY, next.id())?;
    }
    core.set_family(next);
    if !engine.ctx.is_null() {
        unsafe { sd::free_sd_ctx(engine.ctx) };
        engine.ctx = null_mut();
    }
    /* 主窗口缓存着「当前族 + 新建面板默认参数」，切完广播一声——
       不管这次切换是设置窗口点的还是 agent 调的，新建面板都得跟着换。 */
    let _ = app.emit("inspace:gen-family", serde_json::json!({ "family": next.id() }));
    Ok(collect_models(&core))
}

/// 读某族的新建面板默认参数。不传族就是当前族。
#[tauri::command]
pub fn gen_defaults(state: tauri::State<GenState>, family: Option<String>) -> GenDefaults {
    let core = state.0.clone();
    let family = family
        .as_deref()
        .and_then(Family::from_id)
        .unwrap_or_else(|| core.family());
    core.defaults_of(family)
}

/// 保存某族的新建面板默认参数（面板「更多设置」改动时调）。不传族就是当前族。
#[tauri::command]
pub async fn gen_defaults_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, GenState>,
    defaults: GenDefaults,
    family: Option<String>,
) -> Result<GenDefaults, String> {
    let core = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let family = family
            .as_deref()
            .and_then(Family::from_id)
            .unwrap_or_else(|| core.family());
        apply_defaults(core, app, defaults, family)
    })
    .await
    .map_err(|e| format!("保存默认参数失败：{e}"))?
}

/// 恢复某族的出厂参数。不传族就是当前族。
#[tauri::command]
pub async fn gen_defaults_reset(
    app: tauri::AppHandle,
    state: tauri::State<'_, GenState>,
    family: Option<String>,
) -> Result<GenDefaults, String> {
    let core = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let family = family
            .as_deref()
            .and_then(Family::from_id)
            .unwrap_or_else(|| core.family());
        apply_defaults(core, app, family.factory_defaults(), family)
    })
    .await
    .map_err(|e| format!("恢复默认参数失败：{e}"))?
}

fn apply_defaults(
    core: GenCore,
    app: tauri::AppHandle,
    defaults: GenDefaults,
    family: Family,
) -> Result<GenDefaults, String> {
    let next = normalize_defaults(defaults, family);
    let db = app.state::<DbState>();
    {
        let conn = db
            .0
            .lock()
            .map_err(|_| "数据库连接状态异常（前一次访问发生 panic）".to_string())?;
        let text = serde_json::to_string(&next).map_err(|e| format!("参数存不下来：{e}"))?;
        db::write_setting(&conn, family.defaults_key(), &text)?;
    }
    core.set_defaults(family, next.clone());
    Ok(next)
}

/// 检测：列出模型目录里能选的档位，再报这台机器的规格、建议档和该下的文件。
/// 前端拿这个铺「缺什么、下什么、放哪儿」，不做预设组合。
/// 探测显卡要等子进程，所以整趟放到别的线程上跑，别把窗口冻住。
#[tauri::command]
pub async fn gen_models(state: tauri::State<'_, GenState>) -> Result<GenModels, String> {
    let core = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || Ok(collect_models(&core)))
        .await
        .map_err(|e| format!("检测跑不起来：{e}"))?
}

/// 弹系统目录选择框挑模型目录：只负责选，改不改由前端问完再定。
/// 目录这事归用户——agent 那头只管从目录里读档、挑档，不代劳换位置。
#[tauri::command]
pub async fn gen_models_dir_pick(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Option<String> {
    app.dialog()
        .file()
        .set_title("选择模型文件夹")
        .set_parent(&window)
        .blocking_pick_folder()
        .and_then(|picked| picked.into_path().ok())
        .map(|path| path.to_string_lossy().to_string())
}

/// 换模型目录：`dir` 给空就是收回默认位置（数据根里那份）。
/// 换完放掉权重——旧 ctx 已经把上一条路径的权重读进内存了，留着会继续用。
#[tauri::command]
pub async fn gen_models_dir_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, GenState>,
    dir: Option<String>,
) -> Result<GenModels, String> {
    let core = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || apply_models_dir(core, app, dir))
        .await
        .map_err(|e| format!("换目录任务起不来：{e}"))?
}

fn apply_models_dir(
    core: GenCore,
    app: tauri::AppHandle,
    dir: Option<String>,
) -> Result<GenModels, String> {
    let db = app.state::<DbState>();
    let family = core.family();
    let picked = dir
        .map(|text| text.trim().trim_matches('"').to_string())
        .filter(|text| !text.is_empty());
    let next = match picked {
        Some(text) => {
            let path = PathBuf::from(&text);
            if !path.is_absolute() {
                return Err("要的是一个完整的目录路径".to_string());
            }
            if !path.is_dir() {
                return Err(format!("这个文件夹不存在：{text}"));
            }
            Some(path)
        }
        None => None,
    };
    let current = core
        .models_dir
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())[family.index()]
        .clone();
    if next == current {
        return Ok(collect_models(&core));
    }
    let mut engine = core.lock();
    if engine.busy {
        return Err("正在出图，等这一张跑完再换目录".to_string());
    }
    {
        let conn = db
            .0
            .lock()
            .map_err(|_| "数据库连接状态异常（前一次访问发生 panic）".to_string())?;
        let value = next
            .as_ref()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default();
        db::write_setting(&conn, family.dir_key(), &value)?;
    }
    core.set_models_dir(next);
    if !engine.ctx.is_null() {
        unsafe { sd::free_sd_ctx(engine.ctx) };
        engine.ctx = null_mut();
    }
    Ok(collect_models(&core))
}

/// 在资源管理器里打开模型目录：下载清单要说「扔进这里」，得能一点就到。
/// 目录还没建出来就顺手建，空目录不碍事。
#[tauri::command]
pub fn gen_models_reveal(state: tauri::State<GenState>) -> Result<String, String> {
    let dir = state.0.clone().models();
    fs::create_dir_all(&dir).map_err(|e| format!("建不出模型目录 {}：{e}", dir.display()))?;
    open::that(&dir).map_err(|e| format!("打不开模型目录：{e}"))?;
    Ok(dir.display().to_string())
}

/// 换档：校验 → 落库 → 放掉权重。下一次出图按新档重新载入，
/// 正在出图的时候不换——那一张的成图会说不自己是哪个模型出的。
#[tauri::command]
pub async fn gen_models_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, GenState>,
    dit: Option<String>,
    encoder: Option<String>,
) -> Result<GenModels, String> {
    let core = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || apply_weights(core, app, dit, encoder))
        .await
        .map_err(|e| format!("换档任务起不来：{e}"))?
}

fn apply_weights(
    core: GenCore,
    app: tauri::AppHandle,
    dit: Option<String>,
    encoder: Option<String>,
) -> Result<GenModels, String> {
    let db = app.state::<DbState>();
    let dir = core.models();
    let mut next = core.weights();
    if let Some(name) = dit {
        check_available(&dir, &name, Kind::Dit)?;
        next.dit = name;
    }
    if let Some(name) = encoder {
        check_available(&dir, &name, Kind::Encoder)?;
        next.encoder = name;
    }
    if next == core.weights() {
        return Ok(collect_models(&core));
    }
    let mut engine = core.lock();
    if engine.busy {
        return Err("正在出图，等这一张跑完再换档".to_string());
    }
    {
        let conn = db
            .0
            .lock()
            .map_err(|_| "数据库连接状态异常（前一次访问发生 panic）".to_string())?;
        let family = core.family();
        db::write_setting(&conn, family.dit_key(), &next.dit)?;
        db::write_setting(&conn, family.encoder_key(), &next.encoder)?;
    }
    /* 换的就是引擎的进料：旧 ctx 留着只会让下一次出图用错档，直接放掉。
       先改档位再放 ctx，两步都在这把锁里做完——中间要是松一下手，
       挤进来的「开始」会拿旧档又起一个 ctx。 */
    core.set_weights(next);
    if !engine.ctx.is_null() {
        unsafe { sd::free_sd_ctx(engine.ctx) };
        engine.ctx = null_mut();
    }
    Ok(collect_models(&core))
}

/// 槽位收文件：名字得是对的那一类，而且真在目录里。
fn check_available(dir: &Path, name: &str, want: Kind) -> Result<(), String> {
    check_weight_name(name)?;
    if weight_kind(name) != Some(want) {
        return Err(format!("“{name}”不是{}", want.label()));
    }
    if !dir.join(name).is_file() {
        return Err(format!("“{name}”不在模型目录里：{}", dir.display()));
    }
    Ok(())
}

/// nvidia-smi 认到的那张卡。这工具是显卡驱动自带的，不装 CUDA Toolkit 也在，
/// 所以探一眼不算依赖外部软件。
#[derive(Clone)]
pub(super) struct Gpu {
    name: String,
    vram_mb: u64,
}

const MB: u64 = 1024 * 1024;

fn probe_gpu() -> Gpu {
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：不然每次检测闪一个黑框
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().ok();
    let Some(out) = out.filter(|o| o.status.success()) else {
        return Gpu {
            name: String::new(),
            vram_mb: 0,
        };
    };
    // 多卡只取第一行：这台机器上出图就一张卡，第二行是同一张的别名或者别人的机器
    let line = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .to_string();
    let mut parts = line.split(',').map(|p| p.trim());
    let name = parts.next().unwrap_or("").to_string();
    let vram_mb = parts
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .map(|v| v.round() as u64)
        .unwrap_or(0);
    Gpu { name, vram_mb }
}

/// 空闲内存。自己声明 kernel32 的 GlobalMemoryStatusEx，不为一个数字加依赖。
/// 认不到就报 (0, 0)，调用方按「不知道」处理。
#[cfg(windows)]
#[repr(C)]
#[allow(dead_code)] // 只读其中两个数，其余字段是布局的一部分
struct MemoryStatusEx {
    dw_length: u32,
    dw_memory_load: u32,
    ull_total_phys: u64,
    ull_avail_phys: u64,
    ull_total_page_file: u64,
    ull_avail_page_file: u64,
    ull_total_virtual: u64,
    ull_avail_virtual: u64,
    ull_avail_extended_virtual: u64,
}

#[cfg(windows)]
unsafe extern "system" {
    fn GlobalMemoryStatusEx(lp_memory_status: *mut MemoryStatusEx) -> i32;
    fn GetDiskFreeSpaceExW(
        directory_path: *const u16,
        free_bytes_available_to_caller: *mut u64,
        total_number_of_bytes: *mut u64,
        total_number_of_free_bytes: *mut u64,
    ) -> i32;
}

#[cfg(windows)]
fn ram_mb() -> (u64, u64) {
    let mut status = MemoryStatusEx {
        dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };
    let ok = unsafe { GlobalMemoryStatusEx(&mut status) != 0 };
    if ok {
        (status.ull_total_phys / MB, status.ull_avail_phys / MB)
    } else {
        (0, 0)
    }
}

#[cfg(not(windows))]
fn ram_mb() -> (u64, u64) {
    (0, 0)
}

/// 目录所在盘的剩余画布（MB）。目录还没建出来时按最近的已存在父目录算。
fn free_mb(dir: &Path) -> u64 {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let mut target = dir;
        while !target.is_dir() {
            match target.parent() {
                Some(up) => target = up,
                None => return 0,
            }
        }
        let wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        let mut free = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut())
                != 0
        };
        if ok {
            free / MB
        } else {
            0
        }
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        0
    }
}

impl GenCore {
    /// 检测用的机器数字。显卡那条要等子进程，认过一次就记下；
    /// 内存和磁盘每次现读，因为它们本来就在变。
    fn machine(&self) -> Machine {
        let gpu = self
            .gpu
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_or_insert_with(probe_gpu)
            .clone();
        let (ram_total_mb, ram_avail_mb) = ram_mb();
        Machine {
            gpu: gpu.name,
            vram_mb: gpu.vram_mb,
            ram_total_mb,
            ram_avail_mb,
            dir_free_mb: free_mb(&self.models()),
        }
    }
}

fn gb(mb: u64) -> String {
    format!("{:.1} GB", mb as f64 / 1024.0)
}

/// 建议哪一档：编码器和 VAE 是躲不掉的固定开销，剩下的内存和磁盘看能塞进
/// 多大的 DiT，从最大档往下试。认不到机器数字就退回默认档，不瞎猜。
fn advise(machine: &Machine, family: Family) -> (&'static str, u64, String) {
    let tiers = family.tiers();
    let smallest = tiers[0];
    let fallback_name = family.defaults().dit;
    let fallback = tiers
        .iter()
        .find(|(name, _)| *name == fallback_name)
        .unwrap_or(&smallest);
    let (_, vae_bytes) = family.vae();
    let encoder_bytes = match family {
        Family::Qwen21 => ENCODER_BYTES,
        Family::H3Image => H3_ENCODER_BYTES,
    };
    if machine.ram_avail_mb == 0 || machine.dir_free_mb == 0 {
        let need = (fallback.1 + encoder_bytes + vae_bytes) / MB;
        return (
            fallback.0,
            fallback.1,
            format!("认不到这台机器的空闲内存或磁盘余量，先按默认的 {}（这一套 {}）给建议。", fallback.0, gb(need)),
        );
    }
    let fixed = (encoder_bytes + vae_bytes) / MB;
    let ram_budget = machine.ram_avail_mb.saturating_sub(RAM_RESERVE_MB);
    let disk_budget = machine.dir_free_mb.saturating_sub(DISK_RESERVE_MB);
    /* H3 的 DiT 比 Qwen 大一个数量级：只看内存/磁盘会把 Q8 也推荐出来，
       16GB 卡上那是拿满屏 offload 换时间。按显存再压一道上限。 */
    let vram_cap = if family == Family::H3Image {
        match machine.vram_mb {
            0 => u64::MAX,
            v if v >= 32_000 => u64::MAX,
            v if v >= 20_000 => 18_000,
            v if v >= 12_000 => 13_000,
            _ => 9_500,
        }
    } else {
        u64::MAX
    };
    let picked = tiers.iter().rev().find(|(_, bytes)| {
        fixed + bytes / MB <= ram_budget
            && fixed + bytes / MB <= disk_budget
            && bytes / MB <= vram_cap
    });
    let (name, dit_bytes) = *picked.unwrap_or(&smallest);
    let need = (dit_bytes + encoder_bytes + vae_bytes) / MB;
    let mut reason = match picked {
        Some(_) => format!(
            "内存空出 {}、模型目录那个盘还剩 {}，扣掉留给应用和系统的余量，装得下 {}（这一套共 {}）。",
            gb(machine.ram_avail_mb),
            gb(machine.dir_free_mb),
            name,
            gb(need)
        ),
        None => format!(
            "内存只剩 {}、盘还剩 {}，连最小档 {} 那一套（{}）都放不下。先清出地方，或把模型目录换到大盘上。",
            gb(machine.ram_avail_mb),
            gb(machine.dir_free_mb),
            name,
            gb(need)
        ),
    };
    if family == Family::H3Image {
        reason.push_str(
            "H3-Image 是 33B DiT + 32B 编码器：16GB 显卡建议 Q3–Q4 的 DiT 配 Q2 编码器，1–2MP 出图 5–15 秒，16MP 约 2 分钟。",
        );
    }
    if machine.vram_mb == 0 {
        reason.push_str("另外没认到 NVIDIA 显卡，出图会走纯 CPU，慢一个数量级。");
    }
    (name, dit_bytes, reason)
}

/// 建议那一套要扔进目录的文件。字节数是仓库里的真数，不是本地文件的。
fn needed_rows(dir: &Path, family: Family, dit: &str, dit_bytes: u64) -> Vec<NeededRow> {
    let (vae_name, vae_bytes) = family.vae();
    let mut rows: Vec<(String, u64, &'static str, bool, String)> = vec![
        (dit.to_string(), dit_bytes, Kind::Dit.label(), false, match family {
            Family::Qwen21 => DIT_PAGE.to_string(),
            Family::H3Image => H3_DIT_PAGE.to_string(),
        }),
    ];
    match family {
        Family::Qwen21 => {
            rows.push((DEFAULT_ENCODER.to_string(), ENCODER_BYTES, Kind::Encoder.label(), false, ENCODER_PAGE.to_string()));
            rows.push((vae_name.to_string(), vae_bytes, Kind::Vae.label(), false, VAE_PAGE.to_string()));
            rows.push((DEFAULT_VISION.to_string(), VISION_BYTES, Kind::Mmproj.label(), true, ENCODER_PAGE.to_string()));
        }
        Family::H3Image => {
            rows.push((H3_DEFAULT_ENCODER.to_string(), H3_ENCODER_BYTES, Kind::Encoder.label(), false, H3_ENCODER_PAGE.to_string()));
            rows.push((vae_name.to_string(), vae_bytes, Kind::Vae.label(), false, H3_VAE_PAGE.to_string()));
        }
    }
    rows.into_iter()
        .map(|(name, bytes, role, optional, page)| {
            /* 认文件名之外的文件也算「已有」：目录里那份能被识别出来就能跑 */
            let resolved = resolve_weights(dir, family, &family.defaults());
            let present = match weight_kind(&name) {
                Some(Kind::Dit) => dir.join(&resolved.dit).is_file(),
                Some(Kind::Encoder) => dir.join(&resolved.encoder).is_file(),
                Some(Kind::Vae) => resolve_vae(dir, family).is_some(),
                _ => dir.join(&name).is_file(),
            };
            NeededRow {
                present,
                name,
                bytes,
                role,
                optional,
                page,
            }
        })
        .collect()
}

fn tier_rows(dir: &Path, family: Family, recommended: &str) -> Vec<TierRow> {
    family
        .tiers()
        .iter()
        .map(|(name, bytes)| TierRow {
            name: name.to_string(),
            bytes: *bytes,
            recommended: *name == recommended,
            present: dir.join(name).is_file(),
        })
        .collect()
}

fn collect_models(core: &GenCore) -> GenModels {
    let family = core.family();
    let dir = core.models();
    let mut buckets: Vec<Vec<ModelFile>> = vec![Vec::new(), Vec::new(), Vec::new()];
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            if !path.is_file() {
                continue;
            }
            let Some(kind) = weight_kind(&name) else {
                continue;
            };
            let slot = match kind {
                Kind::Dit => 0,
                Kind::Encoder => 1,
                Kind::Vae | Kind::Mmproj => 2,
            };
            let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
            buckets[slot].push(ModelFile { name, bytes });
        }
    }
    for bucket in &mut buckets {
        bucket.sort_by_key(|file| file.bytes);
    }
    let weights = core.weights();
    let machine = core.machine();
    let (dit, dit_bytes, advice) = advise(&machine, family);
    GenModels {
        models_dir: dir.display().to_string(),
        family: family.id(),
        family_label: family.label(),
        max_side: family.max_side(),
        modes: family.modes(),
        dir_is_default: core.is_default_dir(),
        dit: buckets.remove(0),
        encoder: buckets.remove(0),
        fixed: buckets.remove(0),
        current_dit: weights.dit.clone(),
        current_encoder: weights.encoder.clone(),
        missing: missing_weights(&dir, &weights, family),
        machine,
        advice,
        needed: needed_rows(&dir, family, dit, dit_bytes),
        tiers: tier_rows(&dir, family, dit),
    }
}
