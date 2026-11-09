/* 客户版网页里的 3D 查看器。
   这个文件不参与应用打包，导出时原样写成 scene-viewer.js：
   依赖都换成和它同目录的 three / GLTFLoader / RoomEnvironment。
   页面数据在 index.html 的 <script id="scene-data"> 里。 */

import * as THREE from "./three.module.js";
import { GLTFLoader } from "./GLTFLoader.js";
import { clone as cloneModel } from "./SkeletonUtils.js";
import { RoomEnvironment } from "./RoomEnvironment.js";

const SKY = { zenith: "#5f8fbe", horizon: "#dcd5c6", bounce: "#8a7a5e" };
const SUN = Math.PI;

const toWorld = (x, y, z) => [x, z, -y];
const data = JSON.parse(document.getElementById("scene-data").textContent);
const pages = [...document.querySelectorAll(".page")];
const gltfLoader = new GLTFLoader();

const modelCache = new Map();
const textureCache = new Map();

function sunDirection(light) {
  const angle = Number(light?.angle);
  const elev = Number(light?.elev);
  const a = ((Number.isFinite(angle) ? angle : 0) * Math.PI) / 180;
  const e = ((Number.isFinite(elev) ? elev : 45) * Math.PI) / 180;
  const horiz = Math.cos(e);
  return [Math.sin(a) * horiz, Math.sin(e), -Math.cos(a) * horiz];
}

function brighten(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const max = Math.max(...ch, 1);
  const scaled = ch.map((v) => Math.min(255, Math.round((v * 255) / max)));
  return `#${scaled.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function skyTexture() {
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

function footprintOf(p) {
  if (p.points) return p.points;
  return [
    { x: -p.w / 2, y: -p.d / 2 },
    { x: p.w / 2, y: -p.d / 2 },
    { x: p.w / 2, y: p.d / 2 },
    { x: -p.w / 2, y: p.d / 2 },
  ];
}

function partRect(p) {
  const a = (p.rotate * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const q of footprintOf(p)) {
    const px = q.x * cos - q.y * sin;
    const py = q.x * sin + q.y * cos;
    x0 = Math.min(x0, px);
    x1 = Math.max(x1, px);
    y0 = Math.min(y0, py);
    y1 = Math.max(y1, py);
  }
  return { x0: p.x + x0, x1: p.x + x1, y0: p.y + y0, y1: p.y + y1, top: p.z + p.h };
}

function shadowShift(light) {
  const elev = Number(light?.elev);
  if (!light || !(elev > 0)) return null;
  const [dx, , dz] = sunDirection(light);
  const horiz = Math.hypot(dx, dz);
  const len = 1 / Math.tan((elev * Math.PI) / 180);
  if (!(horiz > 1e-4)) return { x: 0, y: 0 };
  return { x: (-dx / horiz) * len, y: (dz / horiz) * len };
}

function contentBox(parts, light) {
  const rects = parts.map(partRect);
  const shift = shadowShift(light);
  if (shift) {
    parts.forEach((p, k) => {
      const r = rects[k];
      for (const h of [p.z, p.z + p.h]) {
        rects.push({
          x0: r.x0 + shift.x * h,
          x1: r.x1 + shift.x * h,
          y0: r.y0 + shift.y * h,
          y1: r.y1 + shift.y * h,
        });
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

function polyGeometry(part) {
  const shape = new THREE.Shape();
  part.points.forEach((p, k) => (k === 0 ? shape.moveTo(p.x, p.y) : shape.lineTo(p.x, p.y)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: part.h, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function roofGeometry(part) {
  const base = footprintOf(part);
  const top = part.points ? base.map(() => ({ x: 0, y: 0 })) : (() => {
    const half = (part.ridge ?? part.w) / 2;
    return base.map((q) => ({ x: q.x < 0 ? -half : half, y: 0 }));
  })();
  const verts = [];
  const put = (q, up) => verts.push(q.x, up, -q.y);
  for (let i = 0; i < base.length; i += 1) {
    const j = (i + 1) % base.length;
    const [a, b, c, d] = [base[i], base[j], top[j], top[i]];
    if (Math.abs(c.x - d.x) < 1e-6 && Math.abs(c.y - d.y) < 1e-6) {
      put(a, 0); put(b, 0); put(c, part.h);
    } else {
      put(a, 0); put(b, 0); put(c, part.h);
      put(a, 0); put(c, part.h); put(d, part.h);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
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

function fitView(scene) {
  const box = contentBox(scene.parts, scene.light);
  const span = Math.max(box.dx, box.dy, 1);
  const cam = scene.camera || {};
  const fov = cam.fov ?? 45;
  const dist = cam.dist ?? (span / 2 / Math.tan((fov / 2) * (Math.PI / 180))) * 1.2;
  return {
    azim: cam.azim ?? 180,
    elev: cam.elev ?? 30,
    dist,
    tx: cam.tx ?? box.cx,
    ty: cam.ty ?? box.cy,
    tz: cam.tz ?? box.dz * 0.35,
    fov,
    box,
  };
}

function easeMaterial(material, env) {
  if (!material) return;
  if (Array.isArray(material)) {
    material.forEach((mat) => easeMaterial(mat, env));
    return;
  }
  if ("envMap" in material && env) {
    material.envMap = env;
    material.envMapIntensity = 0.55;
    material.needsUpdate = true;
  }
}

function buildViewport(stage, sceneData) {
  const canvas = document.createElement("canvas");
  stage.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  const sky = skyTexture();
  scene.background = sky;
  scene.fog = new THREE.Fog(SKY.horizon, 400, 3000);
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 100000);
  const hemi = new THREE.HemisphereLight(0xdfe7f2, 0x4a4438, 0.55);
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
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  scene.add(hemi, ambient, sun, sun.target, ground, root);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
  const env = envTarget.texture;
  pmrem.dispose();

  const view = fitView(sceneData);
  const box = view.box;
  const meshes = new Map();

  function rebuild() {
    const seen = new Set();
    sceneData.parts.forEach((part, index) => {
      const id = String(index);
      seen.add(id);
      if (part.op === "model") {
        let group = meshes.get(id);
        if (!group) {
          group = new THREE.Group();
          group.userData.src = part.src;
          group.userData.modelSize = null;
          root.add(group);
          meshes.set(id, group);
          loadModel(part, group);
        }
        const [wx, wy, wz] = toWorld(part.x, part.y, part.z);
        group.position.set(wx, wy, wz);
        group.rotation.y = (part.rotate * Math.PI) / 180;
        return;
      }
      let mesh = meshes.get(id);
      if (!mesh) {
        const baked = part.op !== "box";
        mesh = new THREE.Mesh(
          baked ? (part.op === "roof" ? roofGeometry(part) : polyGeometry(part)) : unitBox,
          new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 }),
        );
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        root.add(mesh);
        meshes.set(id, mesh);
      }
      const [wx, wy, wz] =
        part.op === "box" ? toWorld(part.x, part.y, part.z + part.h / 2) : toWorld(part.x, part.y, part.z);
      mesh.position.set(wx, wy, wz);
      mesh.scale.set(part.op === "box" ? part.w : 1, part.op === "box" ? part.h : 1, part.op === "box" ? part.d : 1);
      mesh.rotation.y = (part.rotate * Math.PI) / 180;
      mesh.material.color.set(part.tex ? "#ffffff" : part.color || "#b9a887");
      applyTexture(mesh, part);
    });
    for (const [id, mesh] of meshes) {
      if (seen.has(id)) continue;
      root.remove(mesh);
      mesh.traverse?.((node) => {
        if (node.isMesh) {
          if (node.geometry && node.geometry !== unitBox) node.geometry.dispose();
          if (node.material) {
            const list = Array.isArray(node.material) ? node.material : [node.material];
            list.forEach((mat) => mat.dispose());
          }
        }
      });
      meshes.delete(id);
    }
  }

  function applyTexture(mesh, part) {
    if (!part.tex) {
      if (mesh.material.map) {
        mesh.material.map.dispose();
        mesh.material.map = null;
        mesh.material.needsUpdate = true;
      }
      return;
    }
    const url = sceneData.textures?.[part.tex];
    if (!url) return;
    const dims = [part.w || 0, part.d || 0, part.h || 0].sort((a, b) => b - a);
    const rep = Math.max(10, part.texRepeat || 100);
    const rx = Math.max(0.05, dims[0] / rep);
    const ry = Math.max(0.05, dims[1] / rep);
    let entry = textureCache.get(url);
    if (!entry) {
      entry = { texture: null, promise: null };
      entry.promise = new THREE.TextureLoader().loadAsync(url).then((tex) => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = 4;
        entry.texture = tex;
        return tex;
      });
      textureCache.set(url, entry);
    }
    const apply = (tex) => {
      if (!mesh.parent) return;
      const map = tex.clone();
      map.needsUpdate = true;
      map.wrapS = THREE.RepeatWrapping;
      map.wrapT = THREE.RepeatWrapping;
      map.repeat.set(rx, ry);
      if (mesh.material.map) mesh.material.map.dispose();
      mesh.material.map = map;
      mesh.material.needsUpdate = true;
      draw();
    };
    if (entry.texture) apply(entry.texture);
    else entry.promise.then(apply).catch(() => {});
  }

  function loadModel(part, group) {
    const url = sceneData.models?.[part.src];
    if (!url) return;
    let entry = modelCache.get(url);
    if (!entry) {
      entry = { gltf: null, promise: null, box: null, size: null };
      entry.promise = gltfLoader.loadAsync(url).then((gltf) => {
        entry.gltf = gltf;
        entry.box = new THREE.Box3().setFromObject(gltf.scene);
        entry.size = new THREE.Vector3();
        entry.box.getSize(entry.size);
        return entry;
      });
      modelCache.set(url, entry);
    }
    const place = (ready) => {
      if (!group.parent || !ready.gltf) return;
      const clone = cloneModel(ready.gltf.scene);
      const size = ready.size;
      const axis = part.w > 0 ? "x" : "y";
      const desired = part.w > 0 ? part.w : part.h > 0 ? part.h : 80;
      const native = size[axis];
      const scale = (native > 1e-4 ? desired / native : 1) * (part.scale || 1);
      const center = new THREE.Vector3();
      ready.box.getCenter(center);
      const offset = new THREE.Group();
      offset.position.set(-center.x, -ready.box.min.y, -center.z);
      offset.add(clone);
      const holder = new THREE.Group();
      holder.scale.setScalar(scale);
      holder.add(offset);
      group.add(holder);
      clone.traverse((node) => {
        if (!node.isMesh) return;
        node.castShadow = true;
        node.receiveShadow = true;
        if (node.material) {
          const list = Array.isArray(node.material) ? node.material : [node.material];
          const copied = list.map((mat) => {
            const next = mat.clone();
            easeMaterial(next, env);
            return next;
          });
          node.material = Array.isArray(node.material) ? copied : copied[0];
        }
      });
      draw();
    };
    if (entry.gltf) place(entry);
    else entry.promise.then(place).catch(() => {});
  }

  function applyLight() {
    const light = sceneData.light;
    const e = light ? Number(light.elev ?? 45) : 0;
    const on = Boolean(light) && e > 0;
    const k = Math.min(1, Math.max(0, Number(light?.k ?? 0.5)));
    const [dx, dy, dz] = sunDirection(light);
    const span = Math.max(box.span, 1);
    const dist = span * 2;
    sun.visible = on;
    sun.position.set(box.cx + dx * dist, box.dz / 2 + dy * dist, -box.cy + dz * dist);
    sun.target.position.set(box.cx, box.dz / 2, -box.cy);
    sun.intensity = on ? SUN : 0;
    sun.color.set(light?.lit || "#ffffff");
    hemi.color.set(on ? brighten(light?.dark || SKY.zenith) : "#ffffff");
    hemi.groundColor.set(on ? brighten(SKY.bounce) : "#ffffff");
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

  function draw() {
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    const target = toWorld(view.tx, view.ty, view.tz);
    const [dx, dy, dz] = sunDirection({ angle: view.azim, elev: view.elev });
    camera.fov = view.fov;
    camera.aspect = w / h;
    camera.near = Math.max(0.1, view.dist / 2000);
    camera.far = view.dist * 20;
    camera.position.set(view.tx + dx * view.dist, view.tz + dy * view.dist, -view.ty + dz * view.dist);
    camera.lookAt(target[0], target[1], target[2]);
    camera.updateProjectionMatrix();
    const reach = Math.max(box.dx, box.dy);
    ground.scale.set(reach * 10, reach * 10, 1);
    ground.material.color.set(sceneData.groundColor || "#9a917d");
    scene.fog.near = view.dist * 1.15;
    scene.fog.far = view.dist * 2.2;
    renderer.render(scene, camera);
  }

  rebuild();
  applyLight();
  draw();

  /* 拖动旋转、滚轮缩放；松手就停，不用常驻动画循环 */
  let drag = null;
  canvas.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, y: event.clientY, azim: view.azim, elev: view.elev };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!drag) return;
    view.azim = drag.azim - (event.clientX - drag.x) * 0.35;
    view.elev = Math.max(2, Math.min(88, drag.elev + (event.clientY - drag.y) * 0.25));
    draw();
  });
  const endDrag = () => {
    drag = null;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      view.dist = Math.max(10, Math.min(100000, view.dist * (event.deltaY > 0 ? 1.1 : 0.9)));
      draw();
    },
    { passive: false },
  );
  const resize = () => draw();
  window.addEventListener("resize", resize);
  return {
    dispose() {
      window.removeEventListener("resize", resize);
      meshes.forEach((mesh) => {
        mesh.traverse?.((node) => {
          if (node.isMesh) {
            if (node.geometry && node.geometry !== unitBox) node.geometry.dispose();
            if (node.material) {
              const list = Array.isArray(node.material) ? node.material : [node.material];
              list.forEach((mat) => mat.dispose());
            }
          }
        });
      });
      unitBox.dispose();
      ground.geometry.dispose();
      ground.material.dispose();
      sky.dispose();
      envTarget.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

let viewer = null;
let currentViewport = null;

function openViewer(sceneData) {
  closeViewer();
  const mask = document.createElement("div");
  mask.className = "viewer-mask";
  const stage = document.createElement("div");
  stage.className = "viewer-stage";
  const close = document.createElement("button");
  close.className = "viewer-close";
  close.type = "button";
  close.setAttribute("aria-label", "关闭");
  close.textContent = "×";
  const hint = document.createElement("p");
  hint.className = "viewer-hint";
  hint.textContent = "拖动旋转 · 滚轮缩放 · Esc 关闭";
  mask.append(stage, close, hint);
  document.body.append(mask);
  document.body.classList.add("viewer-open");
  close.addEventListener("click", closeViewer);
  mask.addEventListener("click", (event) => {
    if (event.target === mask) closeViewer();
  });
  document.addEventListener("keydown", onViewerKey);
  currentViewport = buildViewport(stage, sceneData);
  viewer = mask;
}

function closeViewer() {
  if (!viewer) return;
  currentViewport?.dispose?.();
  currentViewport = null;
  viewer.remove();
  viewer = null;
  document.body.classList.remove("viewer-open");
  document.removeEventListener("keydown", onViewerKey);
}

function onViewerKey(event) {
  if (event.key === "Escape") closeViewer();
}

/* 把 3D 场景的入口铺在页面上：一个透明热区 + 右下角一枚「3D 预览」 */
for (const scene of data.scenes) {
  const page = pages[scene.page];
  if (!page) continue;
  const host = page.querySelector(".hotspots");
  if (!host) continue;
  const spot = document.createElement("button");
  spot.type = "button";
  spot.className = "scene-hotspot";
  spot.style.left = `${scene.rect.x * 100}%`;
  spot.style.top = `${scene.rect.y * 100}%`;
  spot.style.width = `${scene.rect.w * 100}%`;
  spot.style.height = `${scene.rect.h * 100}%`;
  spot.innerHTML = '<span class="scene-hotspot-label">3D 预览</span>';
  spot.addEventListener("click", () => openViewer(scene));
  host.append(spot);
}
