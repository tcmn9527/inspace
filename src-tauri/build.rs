use std::{env, fs, path::PathBuf};

fn main() {
    tauri_build::build();
    build_engine();
}

/* 把 tools/sdcpp 里的上游 stable-diffusion.cpp 现场编成静态库链进来，
   绑定用 bindgen 现生成 —— 生图面板跑的就是这一份（进程内，不拉子进程）。

   跑之前需要：node scripts/prepare-sdcpp.mjs（取源码）、
   node scripts/prepare-libclang.mjs（bindgen 要的 libclang.dll），
   并且走 npm run dev / npm run build —— scripts/msvc-env.mjs 负责把
   cl.exe、Ninja、CMake、INCLUDE/LIB、CUDA_PATH、LIBCLANG_PATH 注进环境。 */

/// 引擎产物的固定目录（仓库根下的 tools/sdcpp-cache）。故意不跟 cargo 的 OUT_DIR 走：
/// cargo 把「类型检查」和「真编译」算成两种 metadata，各分一份 build 目录，跟着 OUT_DIR
/// 走就是把同一套 383 MB 的静态库编两遍——实测一次十几分钟，两轮就是二十几分钟。
const ENGINE_CACHE: &str = "sdcpp-cache";
/// 配置指纹。内容对不上就整目录清掉重编，不用人记着清（见 CACHE_README）。
const STAMP_FILE: &str = "sdcpp-build.stamp";

const CACHE_README: &str = r#"## 生图引擎的现编缓存

build.rs 把 `../sdcpp` 的上游源码用 CMake + Ninja 编在这儿，Rust 那头直接链这些 .lib。

放在仓库里的固定路径（而不是 cargo 的 OUT_DIR）是有意的：cargo 的 check 和 build 是两个
不同的 build 目录，跟着走就得把同一套静态库编两遍，一次十几分钟。

换 CUDA 大版本（12.x → 13 这种）时，这棵树里的旧对象不能再吃新 toolkit。这一条不用人记着：
build.rs 每次把「上游 pin + CUDA 开关 + CUDA_PATH + 计算能力 + target + 全部 cmake 定义」
写成 `sdcpp-build.stamp`，对不上就自己把这目录清掉重编。

编到一半 Ctrl+C、关机都不用管：指纹在开编之前就落好了，ninja 记着哪些对象真编完了，
下次 `npm run dev` 接着往下编。

真碰上编不过，或者只是想腾出这一个多 GB，整目录删掉就行，下次构建自动重来。
纯产物，别手改，也别入库（.gitignore 里已经挡了）。
"#;

fn build_engine() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo 会给 CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("cargo 会给 OUT_DIR"));
    let repo_root = manifest
        .parent()
        .expect("src-tauri 的上一层就是仓库根")
        .to_path_buf();
    let sd_root = repo_root.join("tools").join("sdcpp");
    let header = sd_root.join("include").join("stable-diffusion.h");
    let pin_path = sd_root.join(".pin");

    // 只有版本换了（.pin 变了）或这份 build.rs 改了才重跑；
    // 平时改一行前端，不该再等十几分钟的 cl.exe。
    println!("cargo:rerun-if-changed={}", pin_path.display());

    if !header.exists() {
        panic!(
            "缺生图引擎源码：{}\n先跑 node scripts/prepare-sdcpp.mjs 取上游 stable-diffusion.cpp。",
            header.display()
        );
    }

    let cuda = env::var("CARGO_FEATURE_CUDA").is_ok();
    let target = env::var("TARGET").expect("cargo 会给 TARGET");
    let msvc = target.contains("msvc");

    generate_bindings(&header, &sd_root, &out_dir);

    let cache = repo_root.join("tools").join(ENGINE_CACHE);
    let stamp = cache.join(STAMP_FILE);
    /* 指纹文件自己也算一个重跑条件：整棵缓存删掉时指纹跟着没了，cargo 就重跑 build.rs，
       而不是拿上一轮的链接参数去指已经不存在的 .lib */
    println!("cargo:rerun-if-changed={}", stamp.display());

    let defines = cmake_defines(cuda, msvc);
    let signature = engine_signature(&sd_root, &defines, cuda, msvc, &target);
    prepare_cache_dir(&cache, &stamp, &signature);
    /* 指纹在开编之前就落盘：cmake 一跑十几分钟，中途 Ctrl+C、断电、关机都不该把已经编出来的
       那几百个对象判成「配置对不上、清掉重编」。续编的账由 ninja 自己记。 */
    write_if_changed(&stamp, &signature);
    write_if_changed(&cache.join("README.md"), CACHE_README);

    let mut cfg = cmake::Config::new(&sd_root);
    cfg.out_dir(cache.join("cmake")).profile("Release");
    if msvc {
        // 不靠 vcvars：msvc-env.mjs 已经把 cl.exe 和 INCLUDE/LIB 塞进环境了。
        cfg.generator("Ninja");
    }
    for (key, value) in &defines {
        cfg.define(key, value);
    }

    let dst = cfg.build();

    /* 静态库之间互相引用（stable-diffusion 用 ggml/onig/utf8proc…），
       少链一个就是 unresolved。CMake 装到哪、装了几个不由我们定，
       所以把 install 树里的 .lib 全收进来，链顺序交给 link.exe。 */
    let mut found = Vec::new();
    collect_libs(&dst, &mut found);
    for lib in &found {
        println!("cargo:rustc-link-search=native={}", lib.parent().unwrap().display());
        let name = lib.file_stem().unwrap().to_string_lossy().to_string();
        println!("cargo:rustc-link-lib=static={name}");
    }
    if found.is_empty() {
        panic!(
            "{} 里一个 .lib 都没有，C++ 那侧八成没编出来\n（实在不行就把 {} 整个删了重来）",
            dst.display(),
            cache.display()
        );
    }

    if cuda {
        // CUDA 那几个是导入库，运行时靠 cudart64_12.dll 等；打包时得一起带。
        if msvc {
            let cuda_lib = PathBuf::from(env::var("CUDA_PATH").expect("开了 cuda 特性就得有 CUDA_PATH")).join("lib/x64");
            println!("cargo:rustc-link-search=native={}", cuda_lib.display());
        }
        for lib in ["cublas", "cublasLt", "cudart", "cuda"] {
            println!("cargo:rustc-link-lib=dylib={lib}");
        }
    }

    println!(
        "cargo:warning=生图引擎：{} 个静态库（CUDA {}，缓存 {}）",
        found.len(),
        if cuda { "开" } else { "关" },
        cache.display()
    );
}

/// 喂给 cmake 的定义项，同时拼成缓存指纹：改任何一条，那棵树自己就作废重编。
/// 返回 (键, 值)，值是 String 是为了把 env 里读来的拼进去。
fn cmake_defines(cuda: bool, msvc: bool) -> Vec<(String, String)> {
    let mut defines = vec![
        ("CMAKE_BUILD_TYPE".to_string(), "Release".to_string()),
        // webp/webm/cutlass 都是 submodule，按 zip 取的包里是空的目录，
        // 开着会 FATAL_ERROR；生图面板也用不上（落块走前端 canvas 编码）。
        ("SD_BUILD_SHARED_LIBS".to_string(), "OFF".to_string()),
        ("SD_BUILD_EXAMPLES".to_string(), "OFF".to_string()),
        ("SD_WEBP".to_string(), "OFF".to_string()),
        ("SD_WEBM".to_string(), "OFF".to_string()),
        ("GGML_OPENMP".to_string(), "OFF".to_string()),
        ("SD_USE_UPSTREAM_GGML".to_string(), "OFF".to_string()),
        ("SD_CUDA_CUTLASS_PATH".to_string(), String::new()),
    ];
    if msvc {
        defines.push(("CMAKE_C_COMPILER".to_string(), "cl.exe".to_string()));
        defines.push(("CMAKE_CXX_COMPILER".to_string(), "cl.exe".to_string()));
        // 模型实现的单个编译单元很大，默认 4096 个 section 会顶不住。
        defines.push(("CMAKE_CXX_FLAGS".to_string(), "'/bigobj'".to_string()));
    }
    if cuda {
        println!("cargo:rerun-if-env-changed=CUDA_PATH");
        println!("cargo:rerun-if-env-changed=CUDA_COMPUTE_CAP");
        defines.push(("SD_CUDA".to_string(), "ON".to_string()));
        // 不给的话 ggml 会按 CUDA 版本凑一串架构轮流编，89 之外的纯浪费十几分钟。
        let arch = env::var("CUDA_COMPUTE_CAP").unwrap_or_else(|_| "89".into());
        defines.push(("CMAKE_CUDA_ARCHITECTURES".to_string(), format!("{arch}-real")));
    }
    defines
}

/// 变了就得重编的那些东西：上游版本、CUDA 开关和 toolkit、目标三元组、全部 cmake 定义。
/// 特意不含 build.rs 自己——改行注释不该赔十几分钟的 cl.exe。
fn engine_signature(sd_root: &PathBuf, defines: &[(String, String)], cuda: bool, msvc: bool, target: &str) -> String {
    let pin = fs::read_to_string(sd_root.join(".pin"))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "没有 .pin".to_string());
    // CUDA_PATH 长末段就是版本号（…\CUDA\v12.8），换大版本这里必变
    let toolkit = env::var("CUDA_PATH")
        .ok()
        .and_then(|p| PathBuf::from(p).file_name().map(|n| n.to_string_lossy().to_string()))
        .unwrap_or_else(|| if cuda { "CUDA_PATH 没设".to_string() } else { "-".to_string() });
    let mut sig = format!("upstream={pin}\ncuda={cuda}\nmsvc={msvc}\ntoolkit={toolkit}\ntarget={target}\n");
    for (key, value) in defines {
        sig.push_str(&format!("{key}={value}\n"));
    }
    sig
}

/// 指纹只对「配置变了」这一件事负责：对不上就把整棵树端掉——留着旧对象只会链出半新半旧的
/// 引擎，或者直接 FATAL_ERROR。指纹不在（首次构建，或上一轮 cmake 被中断在半道）不动树：
/// 谁真编完了由 ninja 的 .ninja_log 记账，清掉整棵等于白赔十几分钟。
fn prepare_cache_dir(cache: &PathBuf, stamp: &PathBuf, signature: &str) {
    if cache.exists() && fs::read_to_string(stamp).is_ok_and(|old| old != signature) {
        println!("cargo:warning=生图引擎缓存的配置变了（换过 CUDA 大版本就是这个），整棵清掉重编");
        fs::remove_dir_all(cache)
            .unwrap_or_else(|e| panic!("清不掉旧的引擎缓存 {}：{e}\n手动删掉这个目录再跑一次。", cache.display()));
    }
    fs::create_dir_all(cache).unwrap_or_else(|e| panic!("建不了引擎缓存目录 {}：{e}", cache.display()));
}

/// 同样的内容不重写：文件一动，cargo 就以为 build.rs 的输出变了，白重编一轮。
fn write_if_changed(path: &PathBuf, content: &str) {
    if fs::read_to_string(path).is_ok_and(|existing| existing == content) {
        return;
    }
    fs::write(path, content).unwrap_or_else(|e| panic!("写不了 {}: {e}", path.display()));
}

fn generate_bindings(header: &PathBuf, sd_root: &PathBuf, out_dir: &PathBuf) {
    if env::var("LIBCLANG_PATH").is_err() {
        panic!(
            "没设 LIBCLANG_PATH，bindgen 起不来。跑过 node scripts/prepare-libclang.mjs 吗，\
             或者是在用 npm run dev / npm run build（scripts/msvc-env.mjs 会注入）？"
        );
    }
    let bindings = bindgen::Builder::default()
        .header(header.to_string_lossy())
        .clang_arg(format!("-I{}", sd_root.join("include").display()))
        // 头文件里 include 了 string.h，bindgen 会连 memcmp/strlen 这些运行时函数
        // 一起照抄成签名不对的声明（size 类型猜错），还会让 Rust 这边以为是自己定义的。
        // 引擎的 C API 不需要它们，直接挡掉。
        .blocklist_function("memcmp")
        .blocklist_function("memcpy")
        .blocklist_function("memmove")
        .blocklist_function("memset")
        .blocklist_function("strlen")
        // 枚举要能匹配不认识的取值（新版本的引擎会加新的 sampler/method），
        // 所以全非穷举 —— 和引擎发布包那份口径一致。
        .rustified_non_exhaustive_enum(".*")
        .parse_callbacks(Box::new(bindgen::CargoCallbacks::new()))
        .generate()
        .unwrap_or_else(|e| panic!("stable-diffusion.h 生成绑定失败：{e}"));
    bindings
        .write_to_file(out_dir.join("sdcpp_bindings.rs"))
        .expect("绑定写不下去");
}

fn collect_libs(dir: &PathBuf, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // CMakeFiles / ninja 的中间产物目录没必要翻
            if path.file_name().map(|n| n == "CMakeFiles").unwrap_or(false) {
                continue;
            }
            collect_libs(&path, out);
        } else if path.extension().map(|e| e == "lib").unwrap_or(false) {
            out.push(path);
        }
    }
}
