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
fn build_engine() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo 会给 CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("cargo 会给 OUT_DIR"));
    let sd_root = manifest
        .parent()
        .expect("src-tauri 的上一层就是仓库根")
        .join("tools")
        .join("sdcpp");
    let header = sd_root.join("include").join("stable-diffusion.h");

    // 只有版本换了（.pin 变了）或这份 build.rs 改了才重编 C++；
    // 平时改一行前端，不该再等十几分钟的 cl.exe。
    println!("cargo:rerun-if-changed={}", sd_root.join(".pin").display());

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

    let mut cfg = cmake::Config::new(&sd_root);
    cfg.out_dir(out_dir.join("sdcpp-build"))
        .profile("Release")
        .define("CMAKE_BUILD_TYPE", "Release")
        // webp/webm/cutlass 都是 submodule，按 zip 取的包里是空的目录，
        // 开着会 FATAL_ERROR；生图面板也用不上（落块走前端 canvas 编码）。
        .define("SD_BUILD_SHARED_LIBS", "OFF")
        .define("SD_BUILD_EXAMPLES", "OFF")
        .define("SD_WEBP", "OFF")
        .define("SD_WEBM", "OFF")
        .define("GGML_OPENMP", "OFF")
        .define("SD_USE_UPSTREAM_GGML", "OFF")
        .define("SD_CUDA_CUTLASS_PATH", "");
    if msvc {
        // 不靠 vcvars：msvc-env.mjs 已经把 cl.exe 和 INCLUDE/LIB 塞进环境了。
        cfg.generator("Ninja")
            .define("CMAKE_C_COMPILER", "cl.exe")
            .define("CMAKE_CXX_COMPILER", "cl.exe")
            // 模型实现的单个编译单元很大，默认 4096 个 section 会顶不住。
            .define("CMAKE_CXX_FLAGS", "'/bigobj'");
    }
    if cuda {
        println!("cargo:rerun-if-env-changed=CUDA_PATH");
        println!("cargo:rerun-if-env-changed=CUDA_COMPUTE_CAP");
        cfg.define("SD_CUDA", "ON");
        // 不给的话 ggml 会按 CUDA 版本凑一串架构轮流编，89 之外的纯浪费十几分钟。
        let arch = env::var("CUDA_COMPUTE_CAP").unwrap_or_else(|_| "89".into());
        cfg.define("CMAKE_CUDA_ARCHITECTURES", format!("{arch}-real"));
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
        panic!("{} 里一个 .lib 都没有，C++ 那侧八成没编出来", dst.display());
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
        "cargo:warning=生图引擎：{} 个静态库（CUDA {}）",
        found.len(),
        if cuda { "开" } else { "关" }
    );
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
