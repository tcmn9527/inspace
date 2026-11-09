/* 场景块的真 3D 渲染器。
 *
 * 和画面块的分界就一句话：画面块的 x/y 是纸上的，场景块的 x/y 是地上的。
 * 所以这里不需要 face（真几何有自己的法线），也不需要 filter shadow 的 h
 * （影子是渲染器从几何算出来的，不是我画给你看的一片多边形）。
 *
 * three.js 有两兆，绝不挂在应用启动的静态 import 链上：第一块场景块进屏幕才 import() 一次。
 */

import * as store from "./canvas-store.js";

/* 场景坐标 → three 世界坐标：x 左右、y 往画面里去（越大越远）、z 立起来多高。
   世界系是 X 右、Y 上、Z 朝观者，所以场景的 y（远）落在 -Z 上。 */
export const toWorld = (x, y, z) => [x, z, -y];

let threePromise = null;
const loadThree = () => {
  if (!threePromise) threePromise = import("/vendor/three/three.module.js");
  return threePromise;
};

/* GLTFLoader 和房间环境光也是进第一块带模型的场景才拉，不和场景块本身互相拖累 */
let gltfPromise = null;
const loadGltf = () => {
  if (!gltfPromise) {
    gltfPromise = Promise.all([
      import("/vendor/three/addons/loaders/GLTFLoader.js"),
      import("/vendor/three/addons/utils/SkeletonUtils.js"),
      import("/vendor/three/addons/environments/RoomEnvironment.js"),
    ]).then(([loader, skeleton, env]) => ({
      GLTFLoader: loader.GLTFLoader,
      cloneModel: skeleton.clone,
      RoomEnvironment: env.RoomEnvironment,
    }));
  }
  return gltfPromise;
};

/* 模型缓存：同一个 .glb 只下载、解析一次，多个场景块各自 clone 一份实例。
   gltf / box / error 三态，promise 用完了也不清——下次还要 clone。 */
const modelCache = new Map();
function modelEntry(THREE, GLTFLoader, src) {
  let entry = modelCache.get(src);
  if (!entry) {
    entry = { gltf: null, box: null, size: null, error: "", promise: null };
    modelCache.set(src, entry);
  }
  if (entry.gltf || entry.promise || entry.error) return entry;
  entry.promise = store
    .modelLibraryUrl(src)
    .then((url) => new GLTFLoader().loadAsync(url))
    .then((gltf) => {
      const box = new THREE.Box3().setFromObject(gltf.scene);
      const size = new THREE.Vector3();
      box.getSize(size);
      if (!(size.x > 1e-4 || size.y > 1e-4 || size.z > 1e-4)) throw new Error("模型里没有可见几何");
      entry.gltf = gltf;
      entry.box = box;
      entry.size = size;
      return entry;
    })
    .catch((error) => {
      entry.error = String(error?.message || error);
      throw error;
    });
  entry.promise.catch(() => {});
  return entry;
}

/* 画布缩放是 CSS transform 乘出来的，WebGL 的位图分辨率不会跟着变——
   所以相机缩放一变就要按新的倍率重画，否则放大到 4 倍就是一坨糊的。 */
let cameraScale = 1;
const owners = new Set();

/* 场景里贴材质图要按「当前画布」取地址；canvas.js 启动时把解析函数塞进来，
   和画面块的 setPictureMedia 同一个套路，避免这儿反过来 import 画布状态。 */
let sceneAsset = null;
export function setSceneAssetProvider(fn) {
  sceneAsset = fn;
}
const sceneTextures = new Map();

const dpr = () => Math.min(window.devicePixelRatio || 1, 2);

function hint(view, text) {
  const p = view.querySelector(".canvas-scene-hint");
  if (p) {
    p.textContent = text;
    p.hidden = !text;
  }
}

/* 一套光的太阳高度和方位，落在世界系里指向太阳的单位向量。
   angle 0 = 光源在正上方（俯视里的正北），顺时针数——和画面块那套是同一个约定。
   角度写缺了不许把 y 和 z 洗成 NaN：整个向量的长度就是「太阳有多远」，NaN 进相机矩阵是一帧黑。 */
export function sunDirection(light) {
  const angle = Number(light?.angle);
  const elev = Number(light?.elev);
  const a = ((Number.isFinite(angle) ? angle : 0) * Math.PI) / 180;
  const e = ((Number.isFinite(elev) ? elev : 45) * Math.PI) / 180;
  const horiz = Math.cos(e);
  return [Math.sin(a) * horiz, Math.sin(e), -Math.cos(a) * horiz];
}

/* 天底到天顶的一圈渐变，按等距柱面贴成背景：相机绕着转的时候天跟着转，
   不会像一张竖着的渐变图那样钉在屏幕上。地平线那一档和下面的雾同色，
   地面拖到远处就是化进天空，看不出「一块浮在页面上的方板」。 */
const SKY = { zenith: "#5f8fbe", horizon: "#dcd5c6", bounce: "#8a7a5e" };

/* 一盏灯正对表面、强度为 π 时，出来的就是固有色本身（见 applyLight 里那段） */
const SUN = Math.PI;

function skyTexture(THREE) {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 256;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, SKY.zenith);
  grad.addColorStop(0.46, SKY.horizon);
  grad.addColorStop(0.54, SKY.bounce);
  grad.addColorStop(1, SKY.bounce);
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* 暗部色（#2f3a52 这种）直接当补光灯用会太暗：它是「影子的颜色」，
   在画面块里是和固有色插值用的，在这儿得先归到满亮度，让它只带色不带压暗，
   压暗多少交给 k。 */
function brighten(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const max = Math.max(...ch, 1);
  const scaled = ch.map((v) => Math.min(255, Math.round((v * 255) / max)));
  return `#${scaled.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function fitCamera(item, box) {
  const w = Math.max(1, item.w);
  const h = Math.max(1, item.h);
  const span = Math.max(box.dx, box.dy, 1);
  const fov = item.camera?.fov ?? 45;
  /* 让最长的那条边正好进框，再留两成余量：贴边看着像被裁 */
  const dist = item.camera?.dist ?? (span / 2 / Math.tan((fov / 2) * (Math.PI / 180))) * 1.2;
  const azim = item.camera?.azim ?? 180;
  const elev = item.camera?.elev ?? 30;
  const a = (azim * Math.PI) / 180;
  const e = (elev * Math.PI) / 180;
  const tx = item.camera?.tx ?? box.cx;
  const ty = item.camera?.ty ?? box.cy;
  const tz = item.camera?.tz ?? box.dz * 0.35;
  const [dx, dy, dz] = sunDirection({ angle: azim, elev });
  return {
    aspect: w / h,
    near: Math.max(0.1, dist / 2000),
    far: dist * 20,
    dist,
    target: toWorld(tx, ty, tz),
    eye: [tx + dx * dist, tz + dy * dist, -ty + dz * dist],
    fov,
  };
}

/* 当前有效机位：块上没定过机位时，返回的是渲染器自动框出来的那一份。
   画布内拖动转视角要在这个基础上接着转，不能从零开始。 */
export function sceneCameraState(item) {
  const box = contentBox(item.parts || [], item.light);
  const cam = fitCamera(item, box);
  return {
    azim: item.camera?.azim ?? 180,
    elev: item.camera?.elev ?? 30,
    dist: item.camera?.dist ?? cam.dist,
    tx: item.camera?.tx ?? box.cx,
    ty: item.camera?.ty ?? box.cy,
    tz: item.camera?.tz ?? box.dz * 0.35,
    fov: item.camera?.fov ?? 45,
  };
}

/* 底面那一圈（相对落点）：box 和矩形屋顶是 w×d 那四角，poly 和多边形屋顶用自己写的点 */
function footprintOf(p) {
  if (p.points) return p.points;
  return [
    { x: -p.w / 2, y: -p.d / 2 },
    { x: p.w / 2, y: -p.d / 2 },
    { x: p.w / 2, y: p.d / 2 },
    { x: -p.w / 2, y: p.d / 2 },
  ];
}

/* 一件东西在地面上的包围盒（先把轮廓按 rotate 转完再框）：
   相机框多大、地面铺多大、阴影盒子多大都靠它。
   poly 那圈点未必围着 (x, y)（一个 L 形的重心可以在轮廓外面），所以逐点算四角，
   不能拿「中心 ± 半边长」糊过去——那样相机框会偏心。 */
export function partRect(p) {
  const a = (p.rotate * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const q of footprintOf(p)) {
    /* 和 mesh.rotation.y 同一个转向：挤出来的 (sx, sy) 落到地面就是这一套 */
    const px = q.x * cos - q.y * sin;
    const py = q.x * sin + q.y * cos;
    if (px < x0) x0 = px;
    if (px > x1) x1 = px;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  }
  return { x0: p.x + x0, x1: p.x + x1, y0: p.y + y0, y1: p.y + y1, top: p.z + p.h };
}

/* 落影相对本体挪多远：太阳高度 e、某一点离地 H，那一点的影就在背向太阳那侧 H/tan(e) 处。
   没挂光 / 太阳贴地（都不打影）一律 null——不许把自动框白白撑大一圈。 */
export function shadowShift(light) {
  const elev = Number(light?.elev);
  if (!light || !(elev > 0)) return null;
  const [dx, , dz] = sunDirection(light);
  const horiz = Math.hypot(dx, dz);
  const len = 1 / Math.tan((elev * Math.PI) / 180);
  /* 正午太阳在头顶：水平分量归零，影就压在脚底下 */
  if (!(horiz > 1e-4)) return { x: 0, y: 0, len: 0 };
  /* 世界 (x, z) → 场景 (x, y=-z)：影子是「背着太阳」那侧，所以取 −d */
  return { x: (-dx / horiz) * len, y: (dz / horiz) * len, len };
}

/* 自动框的尺子：几何本体 + 它拖到地上的那片影。
   只喂给「没定机位时框一个」那条路，还有阴影贴图那圈正交盒子——
   影子被块的边切掉一半，看着就是渲染坏了，不是构图。 */
export function contentBox(parts, light) {
  const rects = parts.map(partRect);
  const shift = shadowShift(light);
  if (shift) {
    parts.forEach((p, k) => {
      const r = rects[k];
      /* 一个实心体的落影是从「底面的影」一路扫到「顶面的影」，两头都框住就全框住了 */
      for (const h of [p.z, p.z + p.h]) {
        rects.push({ x0: r.x0 + shift.x * h, x1: r.x1 + shift.x * h, y0: r.y0 + shift.y * h, y1: r.y1 + shift.y * h });
      }
    });
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let z1 = 0;
  for (const p of parts) z1 = Math.max(z1, p.z + p.h);
  for (const r of rects) {
    x0 = Math.min(x0, r.x0);
    x1 = Math.max(x1, r.x1);
    y0 = Math.min(y0, r.y0);
    y1 = Math.max(y1, r.y1);
  }
  if (!Number.isFinite(x0)) return { cx: 0, cy: 0, dz: 0, dx: 200, dy: 200, span: 200 };
  const dx = Math.max(1, x1 - x0);
  const dy = Math.max(1, y1 - y0);
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, dz: z1, dx, dy, span: Math.max(dx, dy, z1) };
}

/* 模型件的真实包围盒覆盖掉归一化时给的估算尺寸，再按普通件算一遍总框 */
function contentBoxWithModels(item, rects) {
  if (!rects.size) return contentBox(item.parts, item.light);
  const parts = item.parts.map((part, k) => {
    const rect = rects.get(k);
    if (!rect) return part;
    return {
      ...part,
      x: (rect.x0 + rect.x1) / 2,
      y: (rect.y0 + rect.y1) / 2,
      w: Math.max(1, rect.x1 - rect.x0),
      d: Math.max(1, rect.y1 - rect.y0),
      h: Math.max(1, rect.top - part.z),
      rotate: 0,
    };
  });
  return contentBox(parts, item.light);
}

/* 几何只由「体型 + 那圈点 + 立起来多高」决定：挪位置、转角度、换颜色都不必重挤一次 */
const geometrySig = (part) =>
  `${part.op};${part.h};${part.w ?? ""},${part.d ?? ""},${part.ridge ?? ""};${
    part.points ? part.points.map((p) => `${p.x},${p.y}`).join(";") : ""
  }`;

/* 底面轮廓 + h 挤成真棱柱。墙、台基、八角亭身都走这条路，加新体型时渲染器那边不用动。 */
export function polyGeometry(THREE, part) {
  const shape = new THREE.Shape();
  part.points.forEach((p, k) => (k === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)));
  shape.closePath();
  /* 挤出来的是「躺在地上的那张纸沿自己法线拉出一段」：(sx, sy, 深度)。
     绕 X 转 -90° 变成 (sx, 深度, -sy)，正好和 toWorld 那套映射同一次，y 不用再手翻。
     法线不用再算：three 这版（r187）挤出来就是不共用顶点的，一个面片一份法线——
     实测 L 形只有正上下 + 四个朝向的墙，拐角没有被平均成 45°，直角本来就是硬的。 */
  const geo = new THREE.ExtrudeGeometry(shape, { depth: part.h, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/* 檐口那一圈 + 顶上那条脊（或那个尖）。ridge 一个字段就把三种屋顶包了：
   = w 是双坡（悬山 / 硬山），0 < ridge < w 是四阿 / 庑殿，= 0 是四角攒尖；
   底面写成 points（八角、六角）就是那个多边形的攒尖，顶上收成一个点。 */
function roofRings(p) {
  const base = footprintOf(p);
  if (p.points) return { base, top: base.map(() => ({ x: 0, y: 0 })) };
  const half = (p.ridge ?? p.w) / 2;
  return { base, top: base.map((q) => ({ x: q.x < 0 ? -half : half, y: 0 })) };
}

/* 一圈檐口和一条脊之间糊出屋顶：每条底边和它上面那段顶边凑一个面片，
   顶边缩成一个点就自动变成三角——四阿的两头、攒尖的那几面都是这么来的，不用分支。
   不封底：屋顶那几面在水平方向的投影正好盖住底面那一圈，太阳从上面来，
   落影和封了底的实心体一模一样，白省一半三角形。 */
export function roofGeometry(THREE, part) {
  const { base, top } = roofRings(part);
  const verts = [];
  /* 和 toWorld 同一次映射：底面的 (sx, sy) 落在世界 (sx, 离地多高, -sy) */
  const put = (q, up) => verts.push(q.x, up, -q.y);
  for (let i = 0; i < base.length; i += 1) {
    const j = (i + 1) % base.length;
    const [a, b, c, d] = [base[i], base[j], top[j], top[i]];
    if (Math.abs(c.x - d.x) < 1e-6 && Math.abs(c.y - d.y) < 1e-6) {
      put(a, 0);
      put(b, 0);
      put(c, part.h);
    } else {
      put(a, 0);
      put(b, 0);
      put(c, part.h);
      put(a, 0);
      put(c, part.h);
      put(d, part.h);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  /* 绕序统一成「外面朝人」：底面的点是顺时针还是逆时针写的由作者说了算，法线不能跟着翻。
     判据是有向体积为负就每个三角倒过来——檐口那圈在高度 0 的平面上，原点也在这个平面上，
     所以「不封底」算出来的有向体积和封了底是同一个数。 */
  const pos = geo.getAttribute("position");
  const arr = pos.array;
  let volume = 0;
  for (let k = 0; k + 2 < pos.count; k += 3) {
    const [ax, ay, az] = [arr[k * 3], arr[k * 3 + 1], arr[k * 3 + 2]];
    const [bx, by, bz] = [arr[(k + 1) * 3], arr[(k + 1) * 3 + 1], arr[(k + 1) * 3 + 2]];
    const [cx, cy, cz] = [arr[(k + 2) * 3], arr[(k + 2) * 3 + 1], arr[(k + 2) * 3 + 2]];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  if (volume < 0) {
    for (let k = 0; k + 2 < pos.count; k += 3) {
      for (let c = 0; c < 3; c += 1) {
        const i = (k + 1) * 3 + c;
        const j = (k + 2) * 3 + c;
        const t = arr[i];
        arr[i] = arr[j];
        arr[j] = t;
      }
    }
    pos.needsUpdate = true;
  }
  geo.computeVertexNormals();
  return geo;
}

/* 一件东西的几何：box 走共用单位立方体（在 rebuildParts 里），其余都是自己挤一份 */
export function partGeometry(THREE, part) {
  return part.op === "roof" ? roofGeometry(THREE, part) : polyGeometry(THREE, part);
}

function build(view, item, THREE) {
  const canvas = document.createElement("canvas");
  canvas.className = "canvas-scene-gl";
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    /* 导出和 agent 截图都是把这块 canvas 当图片抓的，不开这个标志抓回来是空的 */
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  /* 不做胶片式滚降：ACES 的高光肩部会把饱和的木色、土色一路压向灰，
     实测地面从暖褐 #6C6351 被打成中性灰 #969392——越亮越不像真的。
     宁可强度收着点，让颜色按固有色走。 */
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  const sky = skyTexture(THREE);
  scene.background = sky;
  scene.fog = new THREE.Fog(SKY.horizon, 400, 3000);
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 1000);
  const hemi = new THREE.HemisphereLight(0xdfe7f2, 0x4a4438, 0.55);
  /* 平光用 ambient，不用 hemisphere：半球光按法线上下加权，同一个盒子顶面和侧面
     会差一档——那是「天光」的效果，不是「没打光」。没打光就该每面都是固有色。 */
  const ambient = new THREE.AmbientLight(0xffffff, 0);
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0x8a8f96, roughness: 0.95, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  const root = new THREE.Group();
  /* 所有长方体共用这一块单位立方体，靠 mesh 的 scale 撑开：一百间铺面也只有一份几何。
     poly 的几何是各挤各的，所以删东西时要认得出哪份是公用的。 */
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  scene.add(hemi, ambient, sun, sun.target, ground, root);
  const state = {
    THREE,
    renderer,
    scene,
    camera,
    sun,
    hemi,
    ambient,
    sky,
    ground,
    root,
    unitBox,
    meshMap: new Map(),
    /* 模型件加载后的真实包围盒（场景坐标），相机框和影子盒子按它算 */
    modelRects: new Map(),
    env: null,
    envTarget: null,
    envPending: false,
    view,
    item: null,
  };
  view.__scene = state;
  view.append(canvas);
  hint(view, "");
  ensureEnv(state);
  return state;
}

function rebuildParts(state, item) {
  const { THREE, root, meshMap } = state;
  const seen = new Set();
  state.modelRects.clear();
  item.parts.forEach((part, k) => {
    const id = `${k}`;
    seen.add(id);
    /* GLB 家具：一个模型一份 Group，异步加载；加载完按真实包围盒重新框相机 */
    if (part.op === "model") {
      let group = meshMap.get(id);
      const sig = `model:${part.src}`;
      if (group && group.__sig !== sig) {
        freeMesh(state, group);
        meshMap.delete(id);
        group = null;
      }
      if (!group) {
        group = new THREE.Group();
        group.__sig = sig;
        group.__model = true;
        group.__src = part.src;
        group.__loaded = false;
        group.__materials = [];
        root.add(group);
        meshMap.set(id, group);
        startModelLoad(state, group, part);
      }
      applyModelTransform(group, part);
      if (group.__loaded && group.__size) {
        state.modelRects.set(
          k,
          partRect({
            x: part.x,
            y: part.y,
            z: part.z,
            w: group.__size.w,
            d: group.__size.d,
            h: group.__size.h,
            rotate: part.rotate,
          }),
        );
      }
      return;
    }
    /* box 是单位立方体撑出来的，不用挤；poly / roof 各挤一份真几何 */
    const baked = part.op !== "box";
    const sig = baked ? geometrySig(part) : "";
    let mesh = meshMap.get(id);
    /* 体型或轮廓改过了才整个重挤一次：一件东西的点数封顶 200，
       而拖块、改窗大的时候 render 是每帧都跑的 */
    if (mesh && mesh.__sig !== sig) {
      freeMesh(state, mesh);
      meshMap.delete(id);
      mesh = null;
    }
    if (!mesh) {
      mesh = new THREE.Mesh(
        baked ? partGeometry(THREE, part) : state.unitBox,
        new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 }),
      );
      mesh.__sig = sig;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      root.add(mesh);
      meshMap.set(id, mesh);
    }
    /* 挤出来的几何已经按真实尺寸立好了（底面在自己本地的 y=0），所以只把它「放」到落点上；
       box 是单位立方体，得靠 scale 撑出体型、再抬到身体中心。 */
    const [wx, wy, wz] = baked ? toWorld(part.x, part.y, part.z) : toWorld(part.x, part.y, part.z + part.h / 2);
    mesh.position.set(wx, wy, wz);
    if (baked) mesh.scale.set(1, 1, 1);
    else mesh.scale.set(part.w, part.h, part.d);
    mesh.rotation.y = (part.rotate * Math.PI) / 180;
    /* 有贴图就把固有色收成白，免得把材质图染色 */
    mesh.material.color.set(part.tex ? "#ffffff" : part.color || "#b9a887");
    applyPartTexture(state, part, mesh);
  });
  for (const [id, mesh] of meshMap) {
    if (seen.has(id)) continue;
    freeMesh(state, mesh);
    meshMap.delete(id);
  }
}

function applyModelTransform(group, part) {
  const [wx, wy, wz] = toWorld(part.x, part.y, part.z);
  group.position.set(wx, wy, wz);
  group.rotation.y = (part.rotate * Math.PI) / 180;
}

/* 材质贴图：按「最大两面」估一遍纹理重复——地板取宽×深、墙取宽×高，盒子其余薄面
   本来也看不见。纹理按解析出来的地址缓存，换画布不会串图；每个 mesh 自己克隆一份，
   两张面用同一张材质也能各自设重复。 */
function applyPartTexture(state, part, mesh) {
  const { THREE } = state;
  if (!part.tex) {
    if (mesh.material.map) {
      mesh.material.map.dispose();
      mesh.material.map = null;
      mesh.material.needsUpdate = true;
    }
    mesh.__tex = "";
    return;
  }
  const dims = [part.w || 0, part.d || 0, part.h || 0].sort((a, b) => b - a);
  const rep = Math.max(10, part.texRepeat || 100);
  const rx = Math.max(0.05, dims[0] / rep);
  const ry = Math.max(0.05, dims[1] / rep);
  if (mesh.__tex === part.tex && mesh.material.map) {
    mesh.material.map.repeat.set(rx, ry);
    return;
  }
  if (mesh.__tex === part.tex) return;
  mesh.__tex = part.tex;
  if (!sceneAsset) return;
  sceneAsset(part.tex)
    .then((url) => {
      let entry = sceneTextures.get(url);
      if (!entry) {
        entry = { texture: null, promise: null };
        entry.promise = new THREE.TextureLoader()
          .loadAsync(url)
          .then((tex) => {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.anisotropy = 4;
            entry.texture = tex;
            return tex;
          });
        entry.promise.catch(() => {});
        sceneTextures.set(url, entry);
      }
      return entry.texture || entry.promise;
    })
    .then((tex) => {
      if (!tex || !mesh.parent || mesh.__tex !== part.tex) return;
      const map = tex.clone();
      map.needsUpdate = true;
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(rx, ry);
      if (mesh.material.map) mesh.material.map.dispose();
      mesh.material.map = map;
      mesh.material.needsUpdate = true;
      if (state.item) render(state.view, state, state.item);
    })
    .catch(() => {
      mesh.__tex = "";
    });
}

function startModelLoad(state, group, part) {
  loadGltf()
    .then(({ GLTFLoader, cloneModel }) => {
      const entry = modelEntry(state.THREE, GLTFLoader, part.src);
      const ready = () => {
        if (!group.parent || group.__src !== part.src || group.__loaded) return;
        fillModelGroup(state, group, part, entry, cloneModel);
      };
      if (entry.gltf) ready();
      else entry.promise.then(ready, () => modelFailed(state, part, entry.error));
    })
    .catch((error) => modelFailed(state, part, String(error?.message || error)));
}

function modelFailed(state, part, why) {
  hint(state.view, `模型 ${part.src} 没加载起来：${why}`);
}

/* 把模型摆进 Group：水平居中、底面对齐落点、按期望宽度（或高度）等比缩放。
   模型自带单位五花八门，所以不猜，只按产品卡给的真实尺寸去对。 */
function fillModelGroup(state, group, part, entry, cloneModel) {
  const { THREE } = state;
  const clone = cloneModel(entry.gltf.scene);
  const size = entry.size;
  const axis = part.w > 0 ? "x" : "y";
  const desired = part.w > 0 ? part.w : part.h > 0 ? part.h : 80;
  const native = size[axis];
  const scale = (native > 1e-4 ? desired / native : 1) * (part.scale || 1);
  const center = new THREE.Vector3();
  entry.box.getCenter(center);
  const offset = new THREE.Group();
  offset.position.set(-center.x, -entry.box.min.y, -center.z);
  offset.add(clone);
  const holder = new THREE.Group();
  holder.scale.setScalar(scale);
  holder.add(offset);
  group.add(holder);

  const materials = [];
  clone.traverse((node) => {
    if (!node.isMesh) return;
    node.castShadow = true;
    node.receiveShadow = true;
    const list = Array.isArray(node.material) ? node.material : [node.material];
    const cloned = list.map((mat) => {
      const next = mat.clone();
      if ("envMap" in next) {
        next.envMap = state.env || null;
        next.envMapIntensity = 0.55;
      }
      materials.push(next);
      return next;
    });
    node.material = Array.isArray(node.material) ? cloned : cloned[0];
  });
  group.__materials = materials;
  group.__loaded = true;
  group.__size = { w: size.x * scale, d: size.z * scale, h: size.y * scale };
  /* 真实大小出来了：按它重框一次相机、重算地面和阴影 */
  if (group.parent && state.item) render(state.view, state, state.item);
}

function ensureEnv(state) {
  if (state.env || state.envPending) return;
  state.envPending = true;
  loadGltf()
    .then(({ RoomEnvironment }) => {
      if (!state.renderer) return;
      const pmrem = new state.THREE.PMREMGenerator(state.renderer);
      const target = pmrem.fromScene(new RoomEnvironment(), 0.04);
      state.env = target.texture;
      state.envTarget = target;
      pmrem.dispose();
      applyEnvToModels(state);
    })
    .catch(() => {});
}

function applyEnvToModels(state) {
  for (const group of state.meshMap.values()) {
    if (!group.__model || !group.__materials) continue;
    for (const mat of group.__materials) {
      if (!("envMap" in mat)) continue;
      mat.envMap = state.env;
      mat.envMapIntensity = 0.55;
      mat.needsUpdate = true;
    }
  }
}

/* 收一件东西：材质各一份要还，几何只有挤出来的那些（poly / roof）要还——
   单位立方体是全块共用的，删一栋长方体就 dispose 它，等于把还在场上那些的几何一起拆了。
   模型 Group 里是 clone 出来的实例，只还各自克隆的材质；几何和贴图归全局模型缓存。 */
function freeMesh(state, mesh) {
  if (mesh.__model) {
    for (const mat of mesh.__materials || []) mat.dispose();
    state.root.remove(mesh);
    return;
  }
  if (mesh.geometry !== state.unitBox) mesh.geometry.dispose();
  if (mesh.material.map) mesh.material.map.dispose();
  mesh.material.dispose();
  state.root.remove(mesh);
}

function applyLight(state, item, box) {
  const { sun, hemi, ambient } = state;
  const light = item.light;
  /* 没挂光 = 平光：太阳整个收掉（visible=false 连阴影贴图都不渲），只剩天光。
     强度归 0 不够——three 还是会为这盏灯渲一遍 shadow map，白烧一帧。 */
  const e = light ? Number(light.elev ?? 45) : 0;
  const on = Boolean(light) && e > 0;
  const k = Math.min(1, Math.max(0, Number(light?.k ?? 0.5)));
  const [dx, dy, dz] = sunDirection(light);
  const span = Math.max(box.span, 1);
  const dist = span * 2;
  sun.visible = on;
  sun.position.set(box.cx + dx * dist, box.dz / 2 + dy * dist, -box.cy + dz * dist);
  sun.target.position.set(box.cx, box.dz / 2, -box.cy);
  /* 强度按 π 定档：three.js 的漫反射里带一个 1/π（BRDF_Lambert），
     所以一盏正对表面、强度 π 的灯出来的正好是固有色本身——实测平光下地面
     #9a917d 会渲成 #575246，差的就是这个 π。和画面块对齐：不打光 = 看到的就是定下来的颜色。 */
  sun.intensity = on ? SUN : 0;
  /* 暗部留多少 = k，和画面块同一个意思：影子不是黑的，是固有色剩下那几成。
     dark 先归到满亮度再当天光色用——它是影子的「颜色」，不该顺手把亮度也压掉。
     没挂光那天光必须是白的（上下同色 = 无方向），整块才会均匀保持固有色。 */
  sun.color.set(light?.lit || "#ffffff");
  hemi.color.set(on ? brighten(light?.dark || SKY.zenith) : "#ffffff");
  hemi.groundColor.set(on ? brighten(SKY.bounce) : "#ffffff");
  /* 天光按太阳高度衰减：太阳压得越低，天空本身越暗，暖色的太阳才压得住蓝色天光。
     不衰减的话 22° 那种斜光下，地面被一片蓝洗成中性灰（实测 R-B 只剩 +3，固有色是 +29）。
     留 0.25 的底：太阳落到地平线时天光不会真的归零，否则整块黑成一团。 */
  const skyWeight = on ? Math.max(0.25, Math.sin((e * Math.PI) / 180)) : 0;
  hemi.intensity = SUN * k * skyWeight;
  ambient.intensity = on ? 0 : SUN;
  const ortho = sun.shadow.camera;
  ortho.left = -span;
  ortho.right = span;
  ortho.top = span;
  ortho.bottom = -span;
  ortho.near = Math.max(1, dist / 4);
  ortho.far = dist * 3;
  ortho.updateProjectionMatrix();
  sun.shadow.normalBias = Math.max(0.5, span * 0.003);
}

export function syncScene(view, item) {
  if (!view) return;
  const state = view.__scene;
  if (state) {
    render(view, state, item);
    return;
  }
  if (view.__sceneFailed) return;
  if (!view.__scenePending) {
    view.__scenePending = true;
    loadThree().then(
      (THREE) => {
        view.__scenePending = false;
        if (!view.isConnected) return;
        render(view, build(view, item, THREE), item);
      },
      (error) => {
        view.__scenePending = false;
        view.__sceneFailed = true;
        console.error("场景块加载 three.js 失败：", error);
        hint(view, "三维引擎没加载起来");
      },
    );
  }
}

function render(view, state, item) {
  const { renderer, camera, ground } = state;
  state.item = item;
  owners.add(view);
  /* 先重建：模型件加载完的真实包围盒会写进 modelRects，相机要按它框 */
  rebuildParts(state, item);
  const box = contentBoxWithModels(item, state.modelRects);
  const cam = fitCamera(item, box);
  camera.fov = cam.fov;
  camera.aspect = cam.aspect;
  camera.near = cam.near;
  camera.far = cam.far;
  camera.position.set(...cam.eye);
  camera.lookAt(cam.target[0], cam.target[1], cam.target[2]);
  camera.updateProjectionMatrix();
  applyLight(state, item, box);
  /* 地面要拖到雾里为止：远处那条边一旦看得见，整块就变成「一块浮在页面上的方板」。
     雾的近端卡在内容之后，所以东西本身不吃雾，只有地平的尽头化进天空。 */
  const reach = Math.max(box.dx, box.dy);
  ground.scale.set(reach * 10, reach * 10, 1);
  ground.material.color.set(item.groundColor || "#9a917d");
  /* 雾的近端卡在内容之后一点点：东西本身不许被洗白，只有远处那片空地化进天光 */
  state.scene.fog.near = cam.dist * 1.15;
  state.scene.fog.far = cam.dist * 2.2;
  renderer.setPixelRatio(dpr() * cameraScale);
  renderer.setSize(item.w, item.h, false);
  renderer.render(state.scene, camera);
}

export function disposeScene(view) {
  const state = view?.__scene;
  if (!state) return;
  owners.delete(view);
  for (const mesh of state.meshMap.values()) freeMesh(state, mesh);
  state.unitBox.dispose();
  state.ground.geometry.dispose();
  state.ground.material.dispose();
  state.sky.dispose();
  state.envTarget?.dispose();
  state.renderer.dispose();
  /* 浏览器只给十几个 WebGL 上下文，dispose() 不一定真收回：整块重绘一次就少一条命，
     攒到上限后新场景块一律黑屏。显式让上下文丢失，把这一块的配额还回去。 */
  state.renderer.forceContextLoss();
  view.__scene = null;
}

/* 相机缩放变了：位图要按新的倍率重画一遍，不然放大就是糊的 */
export function setSceneCameraScale(scale) {
  const next = Math.max(0.05, Number(scale) || 1);
  if (Math.abs(next - cameraScale) < 0.001) return;
  cameraScale = next;
  for (const view of owners) if (view.isConnected && view.__scene?.item) syncScene(view, view.__scene.item);
}
