/* stable-diffusion.cpp 的 C API 绑定。

   这些类型和函数不是我们写的，是 build.rs 里 bindgen 从上游
   tools/sdcpp/include/stable-diffusion.h 现生成的，命名风格跟着 C 那边来，
   所以整模块关掉 Rust 的命名和文档检查。上层只通过这个模块碰引擎，
   别处不要直接 include 绑定文件。 */

#![allow(
    non_upper_case_globals,
    non_camel_case_types,
    non_snake_case,
    dead_code,
    clippy::all
)]

include!(concat!(env!("OUT_DIR"), "/sdcpp_bindings.rs"));
