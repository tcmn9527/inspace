//! 体素解码 + marching cubes + 最小 GLB 写出。
//!
//! 网格与 PyTorch 一致：257³ 网格（bbox ±1.01，indexing ij，x 变化最慢），
//! 顶点坐标按 v / 257 * 2.02 - 1.01 映射；三角形绕序与 skimage(lewiner) 相同。

use super::tables::{EDGE_TABLE, TRI_TABLE};

pub const RES: usize = 257;
pub const BOUND: f32 = 1.01;

const EDGE_VERTS: [(usize, usize); 12] = [
    (0, 1),
    (1, 2),
    (2, 3),
    (3, 0),
    (4, 5),
    (5, 6),
    (6, 7),
    (7, 4),
    (0, 4),
    (1, 5),
    (2, 6),
    (3, 7),
];

fn vertex_offset(v: usize) -> (usize, usize, usize) {
    match v {
        0 => (0, 0, 0),
        1 => (1, 0, 0),
        2 => (1, 1, 0),
        3 => (0, 1, 0),
        4 => (0, 0, 1),
        5 => (1, 0, 1),
        6 => (1, 1, 1),
        7 => (0, 1, 1),
        _ => unreachable!(),
    }
}

fn edge_slot(edge: usize) -> (usize, (usize, usize, usize)) {
    let (a, b) = EDGE_VERTS[edge];
    let pa = vertex_offset(a);
    let pb = vertex_offset(b);
    let axis = if pa.0 != pb.0 {
        0
    } else if pa.1 != pb.1 {
        1
    } else {
        2
    };
    let low = if pa.0 + pa.1 + pa.2 <= pb.0 + pb.1 + pb.2 {
        pa
    } else {
        pb
    };
    (axis, low)
}

pub fn marching_cubes(volume: &[f32], s: usize, iso: f32) -> (Vec<[f32; 3]>, Vec<u32>) {
    let n = s * s * s;
    let mut cache: [Vec<u32>; 3] = [vec![u32::MAX; n], vec![u32::MAX; n], vec![u32::MAX; n]];
    let mut verts: Vec<[f32; 3]> = Vec::with_capacity(200_000);
    let mut tris: Vec<u32> = Vec::with_capacity(400_000);
    let at = |i: usize, j: usize, k: usize| (i * s + j) * s + k;

    for i in 0..s - 1 {
        for j in 0..s - 1 {
            for k in 0..s - 1 {
                let mut val = [0f32; 8];
                for v in 0..8 {
                    let (dx, dy, dz) = vertex_offset(v);
                    val[v] = volume[at(i + dx, j + dy, k + dz)];
                }
                let mut ci = 0usize;
                for v in 0..8 {
                    if val[v] < iso {
                        ci |= 1 << v;
                    }
                }
                if EDGE_TABLE[ci] == 0 {
                    continue;
                }
                let mut edge_vert = [u32::MAX; 12];
                let mut bits = EDGE_TABLE[ci];
                while bits != 0 {
                    let e = bits.trailing_zeros() as usize;
                    bits &= bits - 1;
                    let (axis, (lx, ly, lz)) = edge_slot(e);
                    let slot = at(i + lx, j + ly, k + lz);
                    let cached = cache[axis][slot];
                    if cached != u32::MAX {
                        edge_vert[e] = cached;
                        continue;
                    }
                    let (a, b) = EDGE_VERTS[e];
                    let va = val[a];
                    let vb = val[b];
                    let t = if (vb - va).abs() < 1e-12 {
                        0.5
                    } else {
                        (iso - va) / (vb - va)
                    };
                    let (ax, ay, az) = vertex_offset(a);
                    let (bx, by, bz) = vertex_offset(b);
                    let p = [
                        (i + ax) as f32 + t * ((i + bx) as f32 - (i + ax) as f32),
                        (j + ay) as f32 + t * ((j + by) as f32 - (j + ay) as f32),
                        (k + az) as f32 + t * ((k + bz) as f32 - (k + az) as f32),
                    ];
                    let id = verts.len() as u32;
                    verts.push(p);
                    cache[axis][slot] = id;
                    edge_vert[e] = id;
                }
                let tri = &TRI_TABLE[ci];
                let mut m = 0;
                while tri[m] != -1 {
                    tris.push(edge_vert[tri[m] as usize]);
                    tris.push(edge_vert[tri[m + 2] as usize]);
                    tris.push(edge_vert[tri[m + 1] as usize]);
                    m += 3;
                }
            }
        }
    }
    (verts, tris)
}

pub fn to_glb(verts: &mut [[f32; 3]], tris: &[u32]) -> Vec<u8> {
    for v in verts.iter_mut() {
        for c in 0..3 {
            v[c] = v[c] / RES as f32 * (2.0 * BOUND) - BOUND;
        }
    }
    let pos_bytes = verts.len() * 12;
    let idx_bytes = tris.len() * 4;
    let mut bin = Vec::with_capacity(pos_bytes + idx_bytes);
    let mut mn = [f32::MAX; 3];
    let mut mx = [f32::MIN; 3];
    for v in verts.iter() {
        for c in 0..3 {
            mn[c] = mn[c].min(v[c]);
            mx[c] = mx[c].max(v[c]);
            bin.extend_from_slice(&v[c].to_le_bytes());
        }
    }
    for i in tris {
        bin.extend_from_slice(&i.to_le_bytes());
    }
    let json = format!(
        r#"{{"asset":{{"version":"2.0","generator":"inspace"}},"scene":0,"scenes":[{{"nodes":[0]}}],"nodes":[{{"mesh":0}}],"meshes":[{{"primitives":[{{"attributes":{{"POSITION":0}},"indices":1,"material":0}}]}}],"materials":[{{"pbrMetallicRoughness":{{"baseColorFactor":[0.78,0.78,0.78,1.0],"metallicFactor":0.05,"roughnessFactor":0.85}},"doubleSided":true}}],"buffers":[{{"byteLength":{binlen}}}],"bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":{posl}}},{{"buffer":0,"byteOffset":{posl},"byteLength":{idxlen}}}],"accessors":[{{"bufferView":0,"componentType":5126,"count":{nverts},"type":"VEC3","min":[{mn0},{mn1},{mn2}],"max":[{mx0},{mx1},{mx2}]}},{{"bufferView":1,"componentType":5125,"count":{ntris},"type":"SCALAR"}}]}}"#,
        binlen = bin.len(),
        posl = pos_bytes,
        idxlen = idx_bytes,
        nverts = verts.len(),
        ntris = tris.len(),
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
    while bin.len() % 4 != 0 {
        bin.push(0);
    }
    let total = 12 + 8 + json_bytes.len() + 8 + bin.len();
    let mut glb = Vec::with_capacity(total);
    glb.extend_from_slice(b"glTF");
    glb.extend_from_slice(&2u32.to_le_bytes());
    glb.extend_from_slice(&(total as u32).to_le_bytes());
    glb.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    glb.extend_from_slice(b"JSON");
    glb.extend_from_slice(&json_bytes);
    glb.extend_from_slice(&(bin.len() as u32).to_le_bytes());
    glb.extend_from_slice(b"BIN\0");
    glb.extend_from_slice(&bin);
    glb
}
