//! 纹理链的几何侧：GLB 读取、归一化、简化、xatlas UV、6 视图光栅化、颜色烘焙与补洞、带贴图 GLB 写出。
//!
//! 相机与光栅化参数对齐官方 MeshRender（正交、camera_distance 1.45、scale_factor 1.15、
//! elev/azim 六视图），已用 Python 参考逐视图对拍（mask IoU 0.98+）。

pub type V3 = [f64; 3];
type Mat4 = [[f64; 4]; 4];

pub const RES: usize = 512;
pub const TEX: usize = 512;
const SCALE_FACTOR: f64 = 1.15;
const CAMERA_DISTANCE: f64 = 1.45;
const ORTHO: f64 = 0.6;

pub const ELEVS: [f64; 6] = [0.0, 0.0, 0.0, 0.0, 90.0, -90.0];
pub const AZIMS: [f64; 6] = [0.0, 90.0, 180.0, 270.0, 0.0, 180.0];
const WEIGHTS: [f64; 6] = [1.0, 0.1, 0.5, 0.1, 0.05, 0.05];

/// 从几何 GLB（本项目 geo::to_glb 的输出）读顶点与三角形。
pub fn load_glb(data: &[u8]) -> Result<(Vec<V3>, Vec<[u32; 3]>), String> {
    if data.len() < 12 || &data[0..4] != b"glTF" {
        return Err("模型文件格式不对".to_string());
    }
    let mut off = 12usize;
    let mut json: Option<serde_json::Value> = None;
    let mut bin: &[u8] = &[];
    while off + 8 <= data.len() {
        let len = u32::from_le_bytes(data[off..off + 4].try_into().unwrap()) as usize;
        let ty = &data[off + 4..off + 8];
        let body = &data[off + 8..off + 8 + len];
        if ty == b"JSON" {
            json = Some(serde_json::from_slice(body).map_err(|e| format!("模型描述损坏：{e}"))?);
        } else if ty == b"BIN\0" {
            bin = body;
        }
        off += 8 + len;
    }
    let json = json.ok_or_else(|| "模型里没有描述块".to_string())?;
    let prim = &json["meshes"][0]["primitives"][0];
    let read_acc = |acc_idx: u64| -> (usize, usize, usize, usize, usize) {
        let acc = &json["accessors"][acc_idx as usize];
        let bv_idx = acc["bufferView"].as_u64().unwrap_or(0) as usize;
        let bv = &json["bufferViews"][bv_idx];
        let acc_off = acc["byteOffset"].as_u64().unwrap_or(0) as usize;
        let bv_off = bv["byteOffset"].as_u64().unwrap_or(0) as usize;
        let count = acc["count"].as_u64().unwrap_or(0) as usize;
        let comp = acc["componentType"].as_u64().unwrap_or(5126) as usize;
        let ty = acc["type"].as_str().unwrap_or("SCALAR");
        let comps = match ty {
            "VEC2" => 2,
            "VEC3" => 3,
            _ => 1,
        };
        let elem = match comp {
            5125 | 5126 => 4,
            5123 => 2,
            _ => 1,
        };
        let stride = bv["byteStride"].as_u64().map(|v| v as usize).unwrap_or(comps * elem);
        (bv_off + acc_off, count, comp, comps, stride)
    };
    let pos_acc = prim["attributes"]["POSITION"].as_u64().unwrap_or(0);
    let (start, n, comp, comps, stride) = read_acc(pos_acc);
    if comp != 5126 || comps != 3 {
        return Err("模型顶点格式不支持".to_string());
    }
    let mut verts = Vec::with_capacity(n);
    for i in 0..n {
        let base = start + i * stride;
        if base + 12 > bin.len() {
            return Err("模型数据被截断".to_string());
        }
        let x = f32::from_le_bytes(bin[base..base + 4].try_into().unwrap()) as f64;
        let y = f32::from_le_bytes(bin[base + 4..base + 8].try_into().unwrap()) as f64;
        let z = f32::from_le_bytes(bin[base + 8..base + 12].try_into().unwrap()) as f64;
        verts.push([x, y, z]);
    }
    let idx_acc = prim["indices"].as_u64().ok_or_else(|| "模型没有三角形索引".to_string())?;
    let (start, n, comp, _c, stride) = read_acc(idx_acc);
    let mut flat = Vec::with_capacity(n);
    for i in 0..n {
        let base = start + i * stride;
        let v = match comp {
            5125 => u32::from_le_bytes(bin[base..base + 4].try_into().unwrap()),
            5123 => u16::from_le_bytes(bin[base..base + 2].try_into().unwrap()) as u32,
            _ => bin[base] as u32,
        };
        flat.push(v);
    }
    Ok((verts, flat.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()))
}

/// 官方 set_mesh 的坐标整理：取负 x/y、交换 y/z，再按包围球中心归一到半径 1.15/2。
pub fn prepare(v: &mut [V3]) {
    for p in v.iter_mut() {
        p[0] = -p[0];
        p[1] = -p[1];
        p.swap(1, 2);
    }
    let mut mn = [f64::INFINITY; 3];
    let mut mx = [f64::NEG_INFINITY; 3];
    for p in v.iter() {
        for c in 0..3 {
            mn[c] = mn[c].min(p[c]);
            mx[c] = mx[c].max(p[c]);
        }
    }
    let c = [(mn[0] + mx[0]) / 2.0, (mn[1] + mx[1]) / 2.0, (mn[2] + mx[2]) / 2.0];
    let mut max_norm: f64 = 0.0;
    for p in v.iter() {
        let d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
        max_norm = max_norm.max((d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt());
    }
    let k = SCALE_FACTOR / (max_norm * 2.0).max(1e-9);
    for p in v.iter_mut() {
        p[0] = (p[0] - c[0]) * k;
        p[1] = (p[1] - c[1]) * k;
        p[2] = (p[2] - c[2]) * k;
    }
}

/// meshopt 简化：marching cubes 网格几十万面时 xatlas 会慢一个数量级，先降到 ratio 比例。
pub fn simplify(v: Vec<V3>, f: Vec<[u32; 3]>, ratio: f32, rel_err: f32) -> (Vec<V3>, Vec<[u32; 3]>) {
    let pos32: Vec<f32> = v.iter().flat_map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]).collect();
    let pos_bytes =
        unsafe { std::slice::from_raw_parts(pos32.as_ptr() as *const u8, std::mem::size_of_val(&pos32[..])) };
    let Ok(adapter) = meshopt::VertexDataAdapter::new(pos_bytes, 12, 0) else {
        return (v, f);
    };
    let idx: Vec<u32> = f.iter().flat_map(|t| [t[0], t[1], t[2]]).collect();
    let target = (f.len() as f32 * ratio) as usize * 3;
    let mut err = 0.0f32;
    let simplified = meshopt::simplify(
        &idx,
        &adapter,
        target,
        rel_err,
        meshopt::SimplifyOptions::None,
        Some(&mut err),
    );
    if simplified.len() < 3 {
        return (v, f);
    }
    let mut map = vec![u32::MAX; v.len()];
    let mut nv: Vec<V3> = Vec::new();
    let mut nf: Vec<[u32; 3]> = Vec::new();
    for tri in simplified.chunks_exact(3) {
        let mut t3 = [0u32; 3];
        for k in 0..3 {
            let oi = tri[k] as usize;
            if map[oi] == u32::MAX {
                map[oi] = nv.len() as u32;
                nv.push(v[oi]);
            }
            t3[k] = map[oi];
        }
        nf.push(t3);
    }
    (nv, nf)
}

/// xatlas 展开，返回（展开后顶点、[0,1] 归一化 UV、三角形）。
pub fn uv_wrap(v: &[V3], f: &[[u32; 3]]) -> Result<(Vec<V3>, Vec<[f64; 2]>, Vec<[u32; 3]>), String> {
    use xatlas_rs_v2::{ChartOptions, IndexData, MeshData, MeshDecl, PackOptions, Xatlas};
    let pos32: Vec<f32> = v.iter().flat_map(|p| [p[0] as f32, p[1] as f32, p[2] as f32]).collect();
    let idx32: Vec<u32> = f.iter().flat_map(|t| [t[0], t[1], t[2]]).collect();
    let decl = MeshDecl {
        vertex_position_data: MeshData::Contiguous(&pos32),
        index_data: Some(IndexData::U32(&idx32)),
        face_count: f.len() as u32,
        ..Default::default()
    };
    let mut atlas = Xatlas::new();
    atlas.add_mesh(&decl).map_err(|e| format!("展开 UV 失败：{e:?}"))?;
    atlas.generate(&ChartOptions::default(), &PackOptions::default());
    let mesh = atlas.meshes().remove(0);
    let out_v: Vec<V3> = mesh.vertex_array.iter().map(|vt| v[vt.xref as usize]).collect();
    // xatlas 的 uv 是 texel 坐标，且 width()/height() 给的估计值可能偏小；
    // 按 uv 实测最大值归一化（与参考实现一致，uv 落在 [0,1)）
    let mut uv_max: f64 = 0.0;
    for vt in mesh.vertex_array.iter() {
        uv_max = uv_max.max(vt.uv[0] as f64).max(vt.uv[1] as f64);
    }
    if uv_max <= 0.0 {
        return Err("展开 UV 失败：图集为空".to_string());
    }
    let scale = 1.0 / (uv_max + 1.0);
    let out_uv: Vec<[f64; 2]> = mesh
        .vertex_array
        .iter()
        .map(|vt| [vt.uv[0] as f64 * scale, vt.uv[1] as f64 * scale])
        .collect();
    let out_f: Vec<[u32; 3]> = mesh.index_array.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect();
    Ok((out_v, out_uv, out_f))
}

fn normalize(v: V3) -> V3 {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if l < 1e-30 {
        return [0.0, 0.0, 0.0];
    }
    [v[0] / l, v[1] / l, v[2] / l]
}

fn vertex_normals(v: &[V3], f: &[[u32; 3]]) -> Vec<V3> {
    let mut out = vec![[0.0f64; 3]; v.len()];
    for t in f {
        let (a, b, c) = (v[t[0] as usize], v[t[1] as usize], v[t[2] as usize]);
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = normalize([
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ]);
        for k in 0..3 {
            let vi = t[k] as usize;
            out[vi][0] += n[0];
            out[vi][1] += n[1];
            out[vi][2] += n[2];
        }
    }
    out.into_iter().map(normalize).collect()
}

fn mv_matrix(elev: f64, azim: f64) -> Mat4 {
    let elev = -elev;
    let azim = azim + 90.0;
    let e = elev.to_radians();
    let a = azim.to_radians();
    let cam = [
        CAMERA_DISTANCE * e.cos() * a.cos(),
        CAMERA_DISTANCE * e.cos() * a.sin(),
        CAMERA_DISTANCE * e.sin(),
    ];
    let lookat = normalize([-cam[0], -cam[1], -cam[2]]);
    let up0 = [0.0, 0.0, 1.0];
    let right = normalize([
        lookat[1] * up0[2] - lookat[2] * up0[1],
        lookat[2] * up0[0] - lookat[0] * up0[2],
        lookat[0] * up0[1] - lookat[1] * up0[0],
    ]);
    let up = normalize([
        right[1] * lookat[2] - right[2] * lookat[1],
        right[2] * lookat[0] - right[0] * lookat[2],
        right[0] * lookat[1] - right[1] * lookat[0],
    ]);
    let rot = [right, up, [-lookat[0], -lookat[1], -lookat[2]]];
    let t = [
        -(rot[0][0] * cam[0] + rot[0][1] * cam[1] + rot[0][2] * cam[2]),
        -(rot[1][0] * cam[0] + rot[1][1] * cam[1] + rot[1][2] * cam[2]),
        -(rot[2][0] * cam[0] + rot[2][1] * cam[1] + rot[2][2] * cam[2]),
    ];
    [
        [rot[0][0], rot[0][1], rot[0][2], t[0]],
        [rot[1][0], rot[1][1], rot[1][2], t[1]],
        [rot[2][0], rot[2][1], rot[2][2], t[2]],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

fn ortho_proj() -> Mat4 {
    let near = 0.1f64;
    let far = 100.0f64;
    [
        [1.0 / ORTHO, 0.0, 0.0, 0.0],
        [0.0, 1.0 / ORTHO, 0.0, 0.0],
        [0.0, 0.0, -2.0 / (far - near), -(far + near) / (far - near)],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

fn apply(m: &Mat4, p: V3) -> [f64; 4] {
    [
        m[0][0] * p[0] + m[0][1] * p[1] + m[0][2] * p[2] + m[0][3],
        m[1][0] * p[0] + m[1][1] * p[1] + m[1][2] * p[2] + m[1][3],
        m[2][0] * p[0] + m[2][1] * p[1] + m[2][2] * p[2] + m[2][3],
        m[3][0] * p[0] + m[3][1] * p[1] + m[3][2] * p[2] + m[3][3],
    ]
}

/// 六视图法线与位置控制图（RGB [0,1] 量化到 u8，未命中像素为白）。
pub fn render_normal_views(v: &[V3], f: &[[u32; 3]]) -> Vec<(Vec<u8>, Vec<u8>)> {
    let vn = vertex_normals(v, f);
    (0..6)
        .map(|i| {
            let mv = mv_matrix(ELEVS[i], AZIMS[i]);
            let proj = ortho_proj();
            let mut screen = Vec::with_capacity(v.len());
            let mut depth = Vec::with_capacity(v.len());
            for p in v {
                let cam = apply(&mv, *p);
                let clip = apply(&proj, [cam[0], cam[1], cam[2]]);
                screen.push([
                    (clip[0] / clip[3] * 0.5 + 0.5) * RES as f64,
                    (clip[1] / clip[3] * 0.5 + 0.5) * RES as f64,
                ]);
                depth.push(clip[2] / clip[3]);
            }
            let tex_pos: Vec<V3> = v
                .iter()
                .map(|p| [0.5 - p[0] / SCALE_FACTOR, 0.5 - p[1] / SCALE_FACTOR, 0.5 - p[2] / SCALE_FACTOR])
                .collect();
            let mut img_n = vec![[1.0f64; 3]; RES * RES];
            let mut img_p = vec![[1.0f64; 3]; RES * RES];
            let mut zbuf = vec![f64::INFINITY; RES * RES];
            for t in f {
                let (i0, i1, i2) = (t[0] as usize, t[1] as usize, t[2] as usize);
                let p = [screen[i0], screen[i1], screen[i2]];
                let z = [depth[i0], depth[i1], depth[i2]];
                let minx = (p[0][0].min(p[1][0]).min(p[2][0]).floor() as i64).clamp(0, RES as i64 - 1) as usize;
                let maxx = (p[0][0].max(p[1][0]).max(p[2][0]).ceil() as i64).clamp(0, RES as i64 - 1) as usize;
                let miny = (p[0][1].min(p[1][1]).min(p[2][1]).floor() as i64).clamp(0, RES as i64 - 1) as usize;
                let maxy = (p[0][1].max(p[1][1]).max(p[2][1]).ceil() as i64).clamp(0, RES as i64 - 1) as usize;
                let d = (p[1][1] - p[2][1]) * (p[0][0] - p[2][0]) + (p[2][0] - p[1][0]) * (p[0][1] - p[2][1]);
                if d.abs() < 1e-12 {
                    continue;
                }
                let a_n = [vn[i0], vn[i1], vn[i2]];
                let a_p = [tex_pos[i0], tex_pos[i1], tex_pos[i2]];
                for py in miny..=maxy {
                    let gy = py as f64 + 0.5;
                    for px in minx..=maxx {
                        let gx = px as f64 + 0.5;
                        let w0 = ((p[1][1] - p[2][1]) * (gx - p[2][0]) + (p[2][0] - p[1][0]) * (gy - p[2][1])) / d;
                        let w1 = ((p[2][1] - p[0][1]) * (gx - p[2][0]) + (p[0][0] - p[2][0]) * (gy - p[2][1])) / d;
                        let w2 = 1.0 - w0 - w1;
                        if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                            continue;
                        }
                        let zz = w0 * z[0] + w1 * z[1] + w2 * z[2];
                        let at = py * RES + px;
                        if zz >= zbuf[at] {
                            continue;
                        }
                        zbuf[at] = zz;
                        for k in 0..3 {
                            img_n[at][k] = w0 * a_n[0][k] + w1 * a_n[1][k] + w2 * a_n[2][k];
                            img_p[at][k] = w0 * a_p[0][k] + w1 * a_p[1][k] + w2 * a_p[2][k];
                        }
                    }
                }
            }
            let mut n_out = Vec::with_capacity(RES * RES * 3);
            let mut p_out = Vec::with_capacity(RES * RES * 3);
            for at in 0..RES * RES {
                let hit = zbuf[at].is_finite();
                for k in 0..3 {
                    let nv = if hit { (img_n[at][k] + 1.0) * 0.5 } else { 1.0 };
                    n_out.push((nv * 255.0).clamp(0.0, 255.0) as u8);
                    let pv = if hit { img_p[at][k] } else { 1.0 };
                    p_out.push((pv * 255.0).clamp(0.0, 255.0) as u8);
                }
            }
            (n_out, p_out)
        })
        .collect()
}

struct View {
    normal: Vec<[f64; 3]>,
    uv: Vec<[f64; 2]>,
    mask: Vec<bool>,
}

fn render_uv_view(v: &[V3], uv: &[[f64; 2]], f: &[[u32; 3]], elev: f64, azim: f64) -> View {
    let mv = mv_matrix(elev, azim);
    let proj = ortho_proj();
    let mut screen = Vec::with_capacity(v.len());
    let mut depth = Vec::with_capacity(v.len());
    for p in v {
        let cam = apply(&mv, *p);
        let clip = apply(&proj, [cam[0], cam[1], cam[2]]);
        screen.push([
            (clip[0] / clip[3] * 0.5 + 0.5) * RES as f64,
            (clip[1] / clip[3] * 0.5 + 0.5) * RES as f64,
        ]);
        depth.push(cam[2]);
    }
    let mut vn = vec![[0.0f64; 3]; v.len()];
    for t in f {
        let cam = |i: u32| {
            let p = apply(&mv, v[i as usize]);
            [p[0], p[1], p[2]]
        };
        let (a, b, c) = (cam(t[0]), cam(t[1]), cam(t[2]));
        let e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = normalize([
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0],
        ]);
        for k in 0..3 {
            let vi = t[k] as usize;
            vn[vi][0] += n[0];
            vn[vi][1] += n[1];
            vn[vi][2] += n[2];
        }
    }
    for n in vn.iter_mut() {
        *n = normalize(*n);
    }
    let mut normal_img = vec![[0.0f64; 3]; RES * RES];
    let mut uv_img = vec![[0.0f64; 2]; RES * RES];
    let mut zbuf = vec![f64::INFINITY; RES * RES];
    for t in f {
        let (i0, i1, i2) = (t[0] as usize, t[1] as usize, t[2] as usize);
        let p = [screen[i0], screen[i1], screen[i2]];
        let z = [depth[i0], depth[i1], depth[i2]];
        let minx = (p[0][0].min(p[1][0]).min(p[2][0]).floor() as i64).clamp(0, RES as i64 - 1) as usize;
        let maxx = (p[0][0].max(p[1][0]).max(p[2][0]).ceil() as i64).clamp(0, RES as i64 - 1) as usize;
        let miny = (p[0][1].min(p[1][1]).min(p[2][1]).floor() as i64).clamp(0, RES as i64 - 1) as usize;
        let maxy = (p[0][1].max(p[1][1]).max(p[2][1]).ceil() as i64).clamp(0, RES as i64 - 1) as usize;
        let d = (p[1][1] - p[2][1]) * (p[0][0] - p[2][0]) + (p[2][0] - p[1][0]) * (p[0][1] - p[2][1]);
        if d.abs() < 1e-12 {
            continue;
        }
        let a_n = [vn[i0], vn[i1], vn[i2]];
        let a_uv = [uv[i0], uv[i1], uv[i2]];
        for py in miny..=maxy {
            let gy = py as f64 + 0.5;
            for px in minx..=maxx {
                let gx = px as f64 + 0.5;
                let w0 = ((p[1][1] - p[2][1]) * (gx - p[2][0]) + (p[2][0] - p[1][0]) * (gy - p[2][1])) / d;
                let w1 = ((p[2][1] - p[0][1]) * (gx - p[2][0]) + (p[0][0] - p[2][0]) * (gy - p[2][1])) / d;
                let w2 = 1.0 - w0 - w1;
                if w0 < 0.0 || w1 < 0.0 || w2 < 0.0 {
                    continue;
                }
                let zz = w0 * z[0] + w1 * z[1] + w2 * z[2];
                let at = py * RES + px;
                if zz >= zbuf[at] {
                    continue;
                }
                zbuf[at] = zz;
                for k in 0..3 {
                    normal_img[at][k] = w0 * a_n[0][k] + w1 * a_n[1][k] + w2 * a_n[2][k];
                }
                for k in 0..2 {
                    uv_img[at][k] = w0 * a_uv[0][k] + w1 * a_uv[1][k] + w2 * a_uv[2][k];
                }
            }
        }
    }
    let mask: Vec<bool> = zbuf.iter().map(|z| z.is_finite()).collect();
    View { normal: normal_img, uv: uv_img, mask }
}

fn dilate_bool(mask: &[bool], k: usize) -> Vec<bool> {
    let n = RES;
    let mut out = vec![false; n * n];
    for y in 0..n {
        for x in 0..n {
            if !mask[y * n + x] {
                continue;
            }
            for dy in 0..=2 * k {
                let yy = y as i64 + dy as i64 - k as i64;
                if yy < 0 || yy >= n as i64 {
                    continue;
                }
                for dx in 0..=2 * k {
                    let xx = x as i64 + dx as i64 - k as i64;
                    if xx < 0 || xx >= n as i64 {
                        continue;
                    }
                    out[yy as usize * n + xx as usize] = true;
                }
            }
        }
    }
    out
}

fn back_project(view: &View, image: &[[f64; 3]]) -> (Vec<[f64; 3]>, Vec<f64>) {
    let mut cos = vec![0.0f64; RES * RES];
    for i in 0..RES * RES {
        if !view.mask[i] {
            continue;
        }
        let n = normalize(view.normal[i]);
        // 绕序方向随网格来源会翻（xatlas 输出），按朝向取绝对值：背面像素本来就被 zbuf 挡掉
        cos[i] = n[2].abs();
    }
    let bg: Vec<bool> = view.mask.iter().map(|m| !m).collect();
    let bg_dil = dilate_bool(&bg, 2);
    let cos_thres = 75.0f64.to_radians().cos();
    for i in 0..RES * RES {
        if bg_dil[i] || cos[i] < cos_thres {
            cos[i] = 0.0;
        }
    }
    let mut tex = vec![[0.0f64; 3]; TEX * TEX];
    let mut cos_map = vec![0.0f64; TEX * TEX];
    let mut count = vec![0.0f64; TEX * TEX];
    for i in 0..RES * RES {
        if cos[i] <= 0.0 {
            continue;
        }
        let u = view.uv[i][0];
        let vv = view.uv[i][1];
        if !(-0.01..=1.01).contains(&u) || !(-0.01..=1.01).contains(&vv) {
            continue;
        }
        // 烘焙网格的 uv 在 set_mesh 语义下是 (h=v, w=u)；GLB 输出时贴图再垂直翻一次
        let h = vv * (TEX as f64 - 1.0);
        let w = u * (TEX as f64 - 1.0);
        let h0 = (h.floor() as i64).clamp(0, TEX as i64 - 2) as usize;
        let w0 = (w.floor() as i64).clamp(0, TEX as i64 - 2) as usize;
        let fh = h - h0 as f64;
        let fw = w - w0 as f64;
        for (hy, wx, wt) in [
            (h0, w0, (1.0 - fh) * (1.0 - fw)),
            (h0, w0 + 1, (1.0 - fh) * fw),
            (h0 + 1, w0, fh * (1.0 - fw)),
            (h0 + 1, w0 + 1, fh * fw),
        ] {
            let idx = hy * TEX + wx;
            for c in 0..3 {
                tex[idx][c] += image[i][c] * wt;
            }
            cos_map[idx] += cos[i] * wt;
            count[idx] += wt;
        }
    }
    for i in 0..TEX * TEX {
        if count[i] > 0.0 {
            for c in 0..3 {
                tex[i][c] /= count[i];
            }
            cos_map[i] /= count[i];
        }
    }
    (tex, cos_map)
}

/// 多尺度金字塔补洞 + 迭代扩散抛光。
fn inpaint(texture: &[[f64; 3]], trust: &[f64]) -> Vec<[f64; 3]> {
    struct Level {
        n: usize,
        tex: Vec<[f64; 3]>,
        known: Vec<bool>,
    }
    let mut levels: Vec<Level> = Vec::new();
    let known0: Vec<bool> = trust.iter().map(|&t| t > 1e-8).collect();
    levels.push(Level { n: TEX, tex: texture.to_vec(), known: known0 });
    while levels.last().unwrap().n > 16 {
        let prev = levels.last().unwrap();
        let n = prev.n / 2;
        let mut tex = vec![[0.0f64; 3]; n * n];
        let mut known = vec![false; n * n];
        for y in 0..n {
            for x in 0..n {
                let mut sum = [0.0f64; 3];
                let mut cnt = 0.0f64;
                for dy in 0..2 {
                    for dx in 0..2 {
                        let j = (y * 2 + dy) * prev.n + x * 2 + dx;
                        if prev.known[j] {
                            for c in 0..3 {
                                sum[c] += prev.tex[j][c];
                            }
                            cnt += 1.0;
                        }
                    }
                }
                let idx = y * n + x;
                if cnt > 0.0 {
                    for c in 0..3 {
                        tex[idx][c] = sum[c] / cnt;
                    }
                    known[idx] = true;
                }
            }
        }
        levels.push(Level { n, tex, known });
    }
    for li in (0..levels.len() - 1).rev() {
        let (coarse_n, coarse_tex) = {
            let c = &levels[li + 1];
            (c.n, c.tex.clone())
        };
        let fine_n = levels[li].n;
        let mut updates = Vec::new();
        for y in 0..fine_n {
            for x in 0..fine_n {
                let idx = y * fine_n + x;
                if levels[li].known[idx] {
                    continue;
                }
                let cx = (x / 2).min(coarse_n - 1);
                let cy = (y / 2).min(coarse_n - 1);
                updates.push((idx, coarse_tex[cy * coarse_n + cx]));
            }
        }
        for (idx, val) in updates {
            levels[li].tex[idx] = val;
            levels[li].known[idx] = true;
        }
    }
    let mut tex = levels[0].tex.clone();
    let known0: Vec<bool> = trust.iter().map(|&t| t > 1e-8).collect();
    for _ in 0..3 {
        let mut updates = Vec::new();
        for y in 0..TEX {
            for x in 0..TEX {
                let idx = y * TEX + x;
                if known0[idx] {
                    continue;
                }
                let mut sum = [0.0f64; 3];
                let mut cnt = 0.0f64;
                for dy in -1i64..=1 {
                    for dx in -1i64..=1 {
                        let xx = x as i64 + dx;
                        let yy = y as i64 + dy;
                        if xx < 0 || yy < 0 || xx >= TEX as i64 || yy >= TEX as i64 {
                            continue;
                        }
                        let j = yy as usize * TEX + xx as usize;
                        for c in 0..3 {
                            sum[c] += tex[j][c];
                        }
                        cnt += 1.0;
                    }
                }
                if cnt > 0.0 {
                    updates.push((idx, [sum[0] / cnt, sum[1] / cnt, sum[2] / cnt]));
                }
            }
        }
        for (idx, val) in updates {
            tex[idx] = val;
        }
    }
    tex
}

/// 6 视图颜色 → UV 贴图（512² RGB，已补洞）。
pub fn bake_texture(v: &[V3], uv: &[[f64; 2]], f: &[[u32; 3]], views: &[Vec<[f64; 3]>]) -> Vec<[f64; 3]> {
    let mut tex_sum = vec![[0.0f64; 3]; TEX * TEX];
    let mut trust = vec![0.0f64; TEX * TEX];
    for i in 0..6 {
        let view = render_uv_view(v, uv, f, ELEVS[i], AZIMS[i]);
        let (tex, cosm) = back_project(&view, &views[i]);
        let active: usize = cosm.iter().filter(|&&c| c > 0.0).count();
        let painted = (0..TEX * TEX).filter(|&p| cosm[p] > 0.0 && trust[p] > 0.0).count();
        if active > 0 && (painted as f64 / active as f64) > 0.99 {
            continue;
        }
        for p in 0..TEX * TEX {
            let w = WEIGHTS[i] * cosm[p].powi(4);
            if w <= 0.0 {
                continue;
            }
            for c in 0..3 {
                tex_sum[p][c] += tex[p][c] * w;
            }
            trust[p] += w;
        }
    }
    let tex: Vec<[f64; 3]> = (0..TEX * TEX)
        .map(|p| {
            if trust[p] > 1e-8 {
                [tex_sum[p][0] / trust[p], tex_sum[p][1] / trust[p], tex_sum[p][2] / trust[p]]
            } else {
                [0.0; 3]
            }
        })
        .collect();
    inpaint(&tex, &trust)
}

/// 贴图 PNG（垂直翻转后内嵌进 GLB，匹配 glTF 的 v 向下语义）。
pub fn texture_png(texture: &[[f64; 3]]) -> Vec<u8> {
    let mut img = image::RgbImage::new(TEX as u32, TEX as u32);
    for y in 0..TEX {
        for x in 0..TEX {
            let p = y * TEX + x;
            img.put_pixel(
                x as u32,
                y as u32,
                image::Rgb([
                    (texture[p][0] * 255.0).clamp(0.0, 255.0) as u8,
                    (texture[p][1] * 255.0).clamp(0.0, 255.0) as u8,
                    (texture[p][2] * 255.0).clamp(0.0, 255.0) as u8,
                ]),
            );
        }
    }
    let mut flipped = image::RgbImage::new(TEX as u32, TEX as u32);
    for y in 0..TEX {
        for x in 0..TEX {
            flipped.put_pixel(x as u32, y as u32, *img.get_pixel(x as u32, (TEX - 1 - y) as u32));
        }
    }
    let mut png = Vec::new();
    {
        use std::io::Cursor;
        flipped.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
    }
    png
}

pub fn textured_glb_bytes(verts: &[V3], uv: &[[f64; 2]], faces: &[[u32; 3]], png: &[u8]) -> Result<Vec<u8>, String> {
    let mut bin: Vec<u8> = Vec::new();
    let mut mn = [f32::MAX; 3];
    let mut mx = [f32::MIN; 3];
    for v in verts {
        for c in 0..3 {
            mn[c] = mn[c].min(v[c] as f32);
            mx[c] = mx[c].max(v[c] as f32);
            bin.extend_from_slice(&(v[c] as f32).to_le_bytes());
        }
    }
    let pos_len = bin.len();
    for t in uv {
        bin.extend_from_slice(&(t[0] as f32).to_le_bytes());
        bin.extend_from_slice(&(t[1] as f32).to_le_bytes());
    }
    let uv_len = bin.len() - pos_len;
    let idx_off = bin.len();
    for f in faces {
        for k in 0..3 {
            bin.extend_from_slice(&f[k].to_le_bytes());
        }
    }
    let idx_len = bin.len() - idx_off;
    let img_off = bin.len();
    bin.extend_from_slice(png);
    let img_len = png.len();
    while bin.len() % 4 != 0 {
        bin.push(0);
    }
    let json = format!(
        r#"{{"asset":{{"version":"2.0","generator":"inspace-h3d-tex"}},"scene":0,"scenes":[{{"nodes":[0]}}],"nodes":[{{"mesh":0}}],"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0,"TEXCOORD_0":1}},"indices":2,"material":0}}]}}],"materials":[{{"pbrMetallicRoughness":{{"baseColorTexture":{{"index":0}},"metallicFactor":0.0,"roughnessFactor":0.9}},"doubleSided":true}}],"textures":[{{"sampler":0,"source":0}}],"samplers":[{{"magFilter":9729,"minFilter":9987,"wrapS":10497,"wrapT":10497}}],"images":[{{"bufferView":3,"mimeType":"image/png"}}],"buffers":[{{"byteLength":{binlen}}}],"bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":{posl}}},{{"buffer":0,"byteOffset":{posl},"byteLength":{uvl}}},{{"buffer":0,"byteOffset":{idxo},"byteLength":{idxl}}},{{"buffer":0,"byteOffset":{imgo},"byteLength":{imgl}}}],"accessors":[{{"bufferView":0,"componentType":5126,"count":{nv},"type":"VEC3","min":[{mn0},{mn1},{mn2}],"max":[{mx0},{mx1},{mx2}]}},{{"bufferView":1,"componentType":5126,"count":{nv},"type":"VEC2"}},{{"bufferView":2,"componentType":5125,"count":{nidx},"type":"SCALAR"}}]}}"#,
        binlen = bin.len(),
        posl = pos_len,
        uvl = uv_len,
        idxo = idx_off,
        idxl = idx_len,
        imgo = img_off,
        imgl = img_len,
        nv = verts.len(),
        nidx = faces.len() * 3,
        mn0 = mn[0],
        mn1 = mn[1],
        mn2 = mn[2],
        mx0 = mx[0],
        mx1 = mx[1],
        mx2 = mx[2],
    );
    let mut json_bytes = json.into_bytes();
    while json_bytes.len() % 4 != 0 {
        json_bytes.push(b' ');
    }
    let total = 12 + 8 + json_bytes.len() + 8 + bin.len();
    let mut out: Vec<u8> = Vec::with_capacity(total);
    out.extend_from_slice(b"glTF");
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(b"JSON");
    out.extend_from_slice(&json_bytes);
    out.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    out.extend_from_slice(b"BIN\0");
    out.extend_from_slice(&bin);
    Ok(out)
}
