/**
 * Hi-res 3D Sun
 * 1-finger orbit · 2fs (two-finger slide) pan · pinch zoom · Live/home reset
 * The texture is a Carrington map; the longitude facing Earth is in surface.json.
 */
import * as THREE from "three";

const RADIUS = 1;
const HOME_FILL = 0.9;
const MIN_DIST = 1.02;
const MIN_POLAR = 0.15;
const MAX_POLAR = Math.PI - 0.15;
const MAX_PAN = RADIUS * 20;
const PINCH_POWER = 0.4;
const PINCH_EPS = 0.005;
const WHEEL_DOLLY = 0.0012;
/** Base vertical FOV (degrees). Buffer render expands FOV so center crop matches this. */
const BASE_FOV = 40;
/**
 * Extra screen fraction for CSS pan buffer.
 * Was 1.0 → ~3× linear size × DPR ≈ Safari tab crash (“A problem repeatedly occurred”).
 */
const PAN_MARGIN = 0.35;


/** Starfield — fixed sphere behind the Sun */
const STAR_COUNT = 5000;
const STAR_RADIUS = 55;

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildStarfieldBuffers(count = STAR_COUNT, radius = STAR_RADIUS) {
  const rand = mulberry32(42);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = rand();
    const v = rand();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const r = radius * (0.94 + rand() * 0.06);
    const sinPhi = Math.sin(phi);
    positions[i * 3] = r * sinPhi * Math.cos(theta);
    positions[i * 3 + 1] = r * sinPhi * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    const roll = rand();
    const brightness = roll < 0.15 ? 1 : 0.88 + rand() * 0.12;
    const tint = 0.94 + rand() * 0.06;
    colors[i * 3] = brightness * tint;
    colors[i * 3 + 1] = brightness * tint;
    colors[i * 3 + 2] = brightness;
  }
  return { positions, colors };
}

function createStarPointTexture() {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 8;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, 8, 8);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(3, 3, 2, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

/** iPad / tablets — including iPadOS “desktop site” (fine pointer, but touch). */
function isTabletDisplay() {
  if (typeof window === "undefined") return false;
  const minSide = Math.min(window.innerWidth || 0, window.innerHeight || 0);
  if (minSide < 600) return false; // phones
  const touch = (navigator.maxTouchPoints || 0) > 1;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const noHover = window.matchMedia("(hover: none)").matches;
  return touch || coarse || noHover;
}

function starPointSize() {
  return isTabletDisplay() ? 7 : 3;
}

function createStarfield() {
  const { positions, colors } = buildStarfieldBuffers();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const map = createStarPointTexture();
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: starPointSize(),
    sizeAttenuation: false,
    vertexColors: true,
    map: map || undefined,
    transparent: true,
    alphaTest: 0.01,
    depthWrite: false,
    toneMapped: false,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = -10;
  points.userData.starTexture = map;
  return points;
}

const SURFACE = { map: "sun-2k.jpg?v=13", segments: 224 };

/** Matches scripts/update-surface.py. The map is flat; this darkens the rim. */
const LIMB_U = 0.62;

/**
 * Corona. Same limb shell as Mars and Earth.
 * BackSide; fades into space. The Sun has no night side, so the rim glows all around.
 */
const ATMO_HEIGHT = 1.07;
const ATMO_FADE = 0.75;
const ATMO_INTENSITY = 0.6;
const ATMO_COLOR = new THREE.Color(0xffc04a);

const ATMO_VERTEX = /* glsl */ `
varying vec3 vWorldPos;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ATMO_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uIntensity;
uniform float uFadePower;
uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uAtmoRadius;
varying vec3 vWorldPos;
void main() {
  vec3 rd = normalize(vWorldPos - cameraPosition);
  vec3 oc = cameraPosition - uPlanetCenter;
  float dist = length(oc - rd * dot(oc, rd));
  float span = max(uAtmoRadius - uPlanetRadius, 1e-4);
  float h = clamp((dist - uPlanetRadius) / span, 0.0, 1.0);
  float radial = pow(1.0 - h, uFadePower);
  float glow = radial * uIntensity;
  gl_FragColor = vec4(uColor * glow, 1.0);
}
`;

/** Filled from surface.json. L0 is the Carrington longitude facing Earth at `t`. */
let surfaceAnchor = {
  t: Date.parse("2026-10-08T12:00:00Z"),
  l0: 255,
  rotationDays: 27.2753,
};

function l0Degrees(date) {
  const days = (date.getTime() - surfaceAnchor.t) / 86400000;
  const rate = 360 / (surfaceAnchor.rotationDays || 27.2753);
  return (((surfaceAnchor.l0 - rate * days) % 360) + 360) % 360;
}

function carringtonPhase(date) {
  return ((360 - l0Degrees(date)) % 360) / 360;
}


function skyRollRad(latDeg, lonDeg, date) {
  const A = globalThis.Astronomy;
  if (!A) return 0;
  try {
    const time = A.MakeTime(date);
    const obs = new A.Observer(latDeg, lonDeg, 0);
    const eq = A.Equator(A.Body.Sun, time, obs, true, true);
    const gst = A.SiderealTime(time);
    let haHours = gst + lonDeg / 15 - eq.ra;
    while (haHours < -12) haHours += 24;
    while (haHours > 12) haHours -= 24;
    const ha = haHours * A.HOUR2RAD;
    const lat = latDeg * A.DEG2RAD;
    const dec = eq.dec * A.DEG2RAD;
    return Math.atan2(
      Math.sin(ha),
      Math.tan(lat) * Math.cos(dec) - Math.sin(dec) * Math.cos(ha)
    );
  } catch (_) {
    return 0;
  }
}

const TAP_SLOP_PX = 12;
const TAP_MAX_MS = 450;

export function createSunGlobe(canvas, options = {}) {
  const {
    onReady = null,
    onQuality = null,
    onPhase = null,
    onTap = null = null,
  } = options;
  const surface =
    (typeof document !== "undefined" && document.getElementById("touch-plane")) ||
    canvas;

  // DPR = physical pixels per CSS pixel (iPhone ~3, iPad ~2, Retina Mac ~2).
  // Phone/iPad use full device DPR (up to 3); Mac stays capped at 2.5.
  const isTouch =
    (navigator.maxTouchPoints || 0) > 0 ||
    window.matchMedia("(pointer: coarse)").matches;
  const maxPixelRatio = isTouch ? 3 : 2.5;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 200);
  camera.position.set(0, 0, 3.2);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
  renderer.setClearColor(0x020308, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const starfield = createStarfield();
  scene.add(starfield);

  const sunGroup = new THREE.Group();
  scene.add(sunGroup);

  const loader = new THREE.TextureLoader();
  let mesh = null;
  let material = null;
  let ready = false;
  let hqStarted = false;
  let disposed = false;
  let animId = 0;
  let orbiting = false;
  let lastOrbitMs = 0;
  /** Slow spin: one full turn about every 100s — cheap (theta += dt). */
  const ORBIT_RAD_PER_SEC = (2 * Math.PI) / 100;
  let atmosphere = null;
  let atmosphereMat = null;
  const _atmoCenter = new THREE.Vector3();
  const _atmoScale = new THREE.Vector3();
  let width = 0; // CSS viewport width (window)
  let height = 0;
  let bufferW = 0; // drawing buffer / canvas CSS (includes pan margin)
  let bufferH = 0;
  let panMarginPx = 0;
  let homeDist = 3.2;

  // Camera orbits `target`; the Sun stays at `target` (required for 2fs pan).
  const target = new THREE.Vector3(0, 0, 0);
  const spherical = new THREE.Spherical();
  const _offset = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  let prevCamDist = homeDist;
  /** @type {null | { x: number, y: number }} */
  let oneFinger = null;
  /** @type {null | { midX: number, midY: number, span: number }} */
  let twoFinger = null;

  let observerLat = 0;
  let observerLon = 0;
  let when = new Date();
  let lastPhaseInfo = null;
  let orientLocked = false;
  let frozenRoll = 0;
  let frozenSouthern = false;

  function configureColor(tex) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;
    tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
  }


  function buildMesh(map, cfg) {
    if (mesh) {
      sunGroup.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }
    if (material) {
      material.dispose();
      material = null;
    }

    // Keep the file's own bytes. The limb multiply is in that same space.
    map.colorSpace = THREE.NoColorSpace;
    map.needsUpdate = true;
    // Flat photosphere. Limb darkening is view-dependent, so the rim stays the rim.
    material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uLimb: { value: LIMB_U },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vViewW;
        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vViewW = normalize(cameraPosition - worldPos.xyz);
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform float uLimb;
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vViewW;
        void main() {
          vec3 col = texture2D(uMap, vUv).rgb;
          float mu = clamp(dot(normalize(vNormalW), normalize(vViewW)), 0.0, 1.0);
          // 171 brightens toward the rim. The glow stays on the silhouette.
          float rim = pow(1.0 - mu, 1.7);
          col += col * rim * 1.15;
          col += vec3(1.0, 0.78, 0.28) * rim * 0.22;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    material.toneMapped = false;

    mesh = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, cfg.segments, cfg.segments),
      material
    );
    sunGroup.add(mesh);
    ensureAtmosphere();
    applyEphemeris();
  }

  function ensureAtmosphere() {
    if (atmosphere) return;
    atmosphereMat = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERTEX,
      fragmentShader: ATMO_FRAGMENT,
      uniforms: {
        uColor: { value: ATMO_COLOR.clone() },
        uIntensity: { value: ATMO_INTENSITY },
        uFadePower: { value: ATMO_FADE },
        uPlanetCenter: { value: new THREE.Vector3() },
        uPlanetRadius: { value: RADIUS },
        uAtmoRadius: { value: RADIUS * ATMO_HEIGHT },
      },
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(RADIUS, 64, 64),
      atmosphereMat
    );
    atmosphere.renderOrder = 10;
    atmosphere.frustumCulled = false;
    atmosphere.scale.setScalar(ATMO_HEIGHT);
    sunGroup.add(atmosphere);
  }

  function updateAtmosphereLight() {
    if (!atmosphereMat || !atmosphere) return;
    sunGroup.getWorldPosition(_atmoCenter);
    sunGroup.getWorldScale(_atmoScale);
    const g = _atmoScale.x;
    atmosphereMat.uniforms.uPlanetCenter.value.copy(_atmoCenter);
    atmosphereMat.uniforms.uPlanetRadius.value = RADIUS * g;
    atmosphereMat.uniforms.uAtmoRadius.value = RADIUS * ATMO_HEIGHT * g;
  }

  function loadLow() {
    const cfg = SURFACE;
    loader.load(cfg.map, (tex) => {
      if (disposed) return;
      configureColor(tex);
      buildMesh(tex, cfg);
      ready = true;
      if (typeof onReady === "function") onReady();
      if (typeof onQuality === "function") onQuality("2k");
    });
  }


  function captureSkyPose(date = new Date()) {
    frozenSouthern = observerLat < 0;
    frozenRoll = skyRollRad(observerLat, observerLon, date);
  }

  function applyEphemeris() {
    const phase01 = carringtonPhase(when);
    const l0 = l0Degrees(when);
    if (mesh) {
      mesh.rotation.order = "YXZ";
      // Carrington longitude L0 faces the camera. East is to the left.
      mesh.rotation.y = THREE.MathUtils.degToRad(270 + l0);
      mesh.rotation.x = 0;
      mesh.rotation.z = 0;
    }
    const southern = orientLocked ? frozenSouthern : observerLat < 0;
    const skyRoll = orientLocked
      ? frozenRoll
      : skyRollRad(observerLat, observerLon, when);
    // Solar north stays up. Sky roll would lean the poles for the local horizon.
    sunGroup.rotation.set(0, 0, 0);
    sunGroup.position.copy(target);

    lastPhaseInfo = {
      phase01,
      fraction: 1,
      illuminated: 1,
      name: "Sun",
      lat: observerLat,
      lon: observerLon,
      when: new Date(when.getTime()),
      l0,
      southern,
      skyRoll,
      orientLocked,
    };
    if (typeof onPhase === "function") onPhase(lastPhaseInfo);
  }

  function setObserver(lat, lon) {
    let la = Number(lat);
    let lo = Number(lon);
    if (!Number.isFinite(la)) la = 0;
    if (!Number.isFinite(lo)) lo = 0;
    observerLat = THREE.MathUtils.clamp(la, -90, 90);
    while (lo > 180) lo -= 360;
    while (lo < -180) lo += 360;
    observerLon = lo;
    if (orientLocked) captureSkyPose(new Date());
    applyEphemeris();
    return getPhaseInfo();
  }

  function setTime(date = new Date(), opts = {}) {
    when = date instanceof Date ? date : new Date(date);
    if (opts.lockOrient === false) {
      orientLocked = false;
    } else if (opts.lockOrient === true && !orientLocked) {
      captureSkyPose(opts.orientDate || new Date());
      orientLocked = true;
    }
    applyEphemeris();
    return getPhaseInfo();
  }

  function getPhaseInfo() {
    return lastPhaseInfo;
  }

  function getObserver() {
    return { lat: observerLat, lon: observerLon };
  }


  function readHomePadsPx() {
    let top = 48;
    let bottom = 248;
    if (typeof document !== "undefined") {
      const bar = document.getElementById("loc-bar");
      const chrome = document.querySelector(".chrome");
      if (chrome) {
        const h = chrome.getBoundingClientRect().height;
        if (h > 0) top = Math.ceil(h);
      } else {
        const probe = document.createElement("div");
        probe.style.cssText =
          "position:absolute;visibility:hidden;pointer-events:none;width:0";
        document.body.appendChild(probe);
        probe.style.height = "calc(2rem + env(safe-area-inset-top, 0px))";
        top = probe.offsetHeight || top;
        probe.remove();
      }
      if (bar) {
        const h = bar.getBoundingClientRect().height;
        if (h > 0) bottom = Math.ceil(h);
      } else {
        const probe = document.createElement("div");
        probe.style.cssText =
          "position:absolute;visibility:hidden;pointer-events:none;width:0";
        document.body.appendChild(probe);
        probe.style.height = "15.5rem";
        bottom = probe.offsetHeight || bottom;
        probe.remove();
      }
    }
    return { top, bottom };
  }

  /**
   * Home distance for full-window canvas: disk sized to the band above the
   * bottom info area. Zoom can still go closer and fill the whole screen.
   */
  function computeHomeDistance(w, h) {
    const pads = readHomePadsPx();
    const availH = Math.max(160, h - pads.top - pads.bottom);
    const availW = Math.max(160, w - 24);
    // Always size home against the *viewport* FOV (BASE_FOV), not the buffer FOV
    const vFov = THREE.MathUtils.degToRad(BASE_FOV);
    const aspect = Math.max(w, 1) / Math.max(h, 1);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const fit = HOME_FILL;
    const distV = (RADIUS * h) / (fit * availH * Math.tan(vFov / 2));
    const distH = (RADIUS * w) / (fit * availW * Math.tan(hFov / 2));
    return Math.max(distV, distH, MIN_DIST + 0.2);
  }

  function readSpherical() {
    _offset.copy(camera.position).sub(target);
    if (_offset.lengthSq() < 1e-12) _offset.set(0, 0, homeDist || 3);
    spherical.setFromVector3(_offset);
  }

  function writeCamera() {
    spherical.phi = THREE.MathUtils.clamp(spherical.phi, MIN_POLAR, MAX_POLAR);
    spherical.radius = THREE.MathUtils.clamp(
      spherical.radius,
      MIN_DIST,
      Math.max(homeDist, MIN_DIST + 0.2)
    );
    spherical.makeSafe();
    _offset.setFromSpherical(spherical);
    camera.position.copy(target).add(_offset);
    camera.up.set(0, 1, 0);
    camera.lookAt(target);
    // Near plane must be *closer* than the front of the sphere (dist − RADIUS).
    // Default near=0.05 clipped the disk when zoomed in → hard L/R edges.
    const dist = spherical.radius;
    const frontGap = dist - RADIUS; // distance camera → front of disk
    camera.near = Math.max(0.001, frontGap * 0.35);
    camera.far = Math.max(200, dist + 40);
    camera.updateProjectionMatrix();
  }

  function camDist() {
    return camera.position.distanceTo(target);
  }

  function syncSun() {
    sunGroup.position.copy(target);
  }

  /** Extra home lift above safe-band center (CSS px for 0.375in = 1/4" + 1/8"). */
  function homeExtraUpPx() {
    let px = 36; // 0.375in @ 96dpi fallback
    if (typeof document !== "undefined") {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:absolute;visibility:hidden;pointer-events:none;width:0;height:0.375in";
      document.body.appendChild(probe);
      px = probe.offsetHeight || px;
      probe.remove();
    }
    return px;
  }

  function measureCssLength(cssLen, fallbackPx) {
    if (typeof document === "undefined") return fallbackPx;
    const probe = document.createElement("div");
    probe.style.cssText =
      `position:absolute;visibility:hidden;pointer-events:none;width:0;height:${cssLen}`;
    document.body.appendChild(probe);
    const px = probe.offsetHeight || fallbackPx;
    probe.remove();
    return px;
  }

  /**
   * Positive = shift home Sun down (CSS translateY).
   * Phone Safari (browser tab only): +1/8". Phone PWA / Chrome: unchanged.
   * iPad: +1/8". Mac / desktop: +1/4".
   */
  function isPhoneSafariBrowser() {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      return false;
    }
    const ua = navigator.userAgent || "";
    if (!/iPhone|iPod/.test(ua)) return false;
    // Home-screen / standalone PWA keeps original framing
    if (
      window.navigator.standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches
    ) {
      return false;
    }
    // Chrome / Firefox / Edge on iOS — not Safari
    if (/CriOS|FxiOS|EdgiOS|OPiOS|OPT\//.test(ua)) return false;
    return /Safari/i.test(ua);
  }

  function homeLowerBiasPx() {
    if (typeof window === "undefined") return 0;
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const minSide = Math.min(window.innerWidth || 0, window.innerHeight || 0);
    // Phone Safari tab: nudge the Sun down 1/8" at startup / Live home
    if (coarse && minSide <= 500) {
      if (isPhoneSafariBrowser()) return measureCssLength("0.125in", 12);
      return 0;
    }
    // iPad / large tablets
    if (coarse) return measureCssLength("0.125in", 12);
    // MacBook / desktop
    return measureCssLength("0.25in", 24);
  }

  /** CSS Y so home Sun sits in the upper safe band (above bottom info), not mid-screen. */
  function homeScreenOffsetY() {
    const pads = readHomePadsPx();
    // Safe-band center is above the viewport center when bottom pad > top pad.
    // CSS translateY: negative = content moves up. Extra 3/8" on startup.
    return (pads.top - pads.bottom) / 2 - homeExtraUpPx() + homeLowerBiasPx();
  }

  function applyHomeFraming() {
    target.set(0, 0, 0);
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, homeDist);
    clearScreenPan();
    // Phone home: lift into top band (fades out as you zoom — see applyCanvasPanTransform)
    homeLiftY = homeScreenOffsetY();
    applyCanvasPanTransform();
    readSpherical();
    writeCamera();
    syncSun();
    prevCamDist = homeDist;
    applyEphemeris();
  }

  function setCamDist(dist) {
    dist = THREE.MathUtils.clamp(dist, MIN_DIST, Math.max(homeDist, MIN_DIST + 0.2));
    // Full un-zoom (max distance) → starting location + face-on orientation
    if (dist >= homeDist - 1e-4) {
      applyHomeFraming();
      return;
    }
    readSpherical();
    spherical.radius = dist;
    writeCamera();
    prevCamDist = camDist();
    // Re-apply pan so home lift eases out toward full-bleed zoom
    applyCanvasPanTransform();
  }

  /**
   * 2fs pan — CSS translate (works on phone) within a larger GL buffer so
   * sliding never reveals empty L/R “edges”.
   */
  let screenPanX = 0;
  let screenPanY = 0;
  /** Home-only vertical lift; faded to 0 as camera dollies in (full-bleed zoom). */
  let homeLiftY = 0;

  function homeLiftFade() {
    const dist = camDist();
    const span = Math.max(homeDist - MIN_DIST, 0.01);
    // 1 at home distance, 0 at max zoom
    const t = THREE.MathUtils.clamp((dist - MIN_DIST) / span, 0, 1);
    return t * t;
  }

  function applyCanvasPanTransform() {
    // Canvas is already offset by -panMarginPx so viewport shows the center.
    // User pan is added on top; clamp so we stay inside the buffer.
    const lift = homeLiftY * homeLiftFade();
    const x = THREE.MathUtils.clamp(screenPanX, -panMarginPx, panMarginPx);
    const y = THREE.MathUtils.clamp(screenPanY + lift, -panMarginPx, panMarginPx);
    screenPanX = x;
    // Keep user pan separate from home lift in stored screenPanY
    screenPanY = THREE.MathUtils.clamp(screenPanY, -panMarginPx, panMarginPx);
    canvas.style.transform = `translate(${x}px, ${y}px)`;
  }

  function panCamera(dxPx, dyPx) {
    if (Math.abs(dxPx) < 0.5 && Math.abs(dyPx) < 0.5) return;

    screenPanX += dxPx;
    screenPanY += dyPx;
    applyCanvasPanTransform();

    // Keep 3D pivot in sync with the slide
    camera.updateMatrixWorld(true);
    const dist = Math.max(camDist(), MIN_DIST);
    const vFov = THREE.MathUtils.degToRad(BASE_FOV);
    const h = Math.max(height || window.innerHeight || 1, 1);
    const worldPerPx = (2.2 * dist * Math.tan(vFov / 2)) / h;
    _right.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    _up.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
    const sx = -dxPx * worldPerPx;
    const sy = dyPx * worldPerPx;
    target.addScaledVector(_right, sx);
    target.addScaledVector(_up, sy);
    camera.position.addScaledVector(_right, sx);
    camera.position.addScaledVector(_up, sy);
    if (target.length() > MAX_PAN) {
      const s = MAX_PAN / target.length();
      const nt = target.clone().multiplyScalar(s);
      camera.position.add(nt.clone().sub(target));
      target.copy(nt);
    }
    syncSun();
    readSpherical();
  }

  function clearScreenPan() {
    screenPanX = 0;
    screenPanY = 0;
    applyCanvasPanTransform();
  }

  function fitToHost() {
    // Size to the real clip host so the canvas always fills edge-to-edge
    // (window.innerHeight can be short of the fixed host on iOS).
    const host = canvas.parentElement;
    let w = window.innerWidth || document.documentElement.clientWidth || 1;
    let h = window.innerHeight || document.documentElement.clientHeight || 1;
    if (host) {
      const rect = host.getBoundingClientRect();
      if (rect.width > 0) w = Math.max(w, rect.width);
      if (rect.height > 0) h = Math.max(h, rect.height);
      // If host stopped above the visual bottom (home-indicator band), extend
      const gap = Math.max(0, (window.innerHeight || 0) - rect.bottom);
      if (gap > 0 && gap < 80) h += gap;
    }
    const vv = window.visualViewport;
    if (vv) {
      w = Math.max(w, vv.width || 0);
      h = Math.max(h, vv.height || 0, (vv.offsetTop || 0) + (vv.height || 0));
    }
    resize(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  }

  function resize(cssW, cssH) {
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    if (w === width && h === height && bufferW > 0) return;

    const prevHome = homeDist;
    const dist = camDist();
    const atHome = dist >= prevHome * 0.97 && target.lengthSq() < 1e-4;
    const zoomFrac = prevHome > 0 ? dist / prevHome : 1;

    width = w;
    height = h;
    // Base pan buffer for 2fs. Also must cover home CSS lift (Sun sits high so
    // bottom of host stays filled — otherwise a black strip clips the disk).
    const homeLift = Math.abs(homeScreenOffsetY());
    panMarginPx = Math.max(
      Math.ceil(Math.max(w, h) * PAN_MARGIN),
      Math.ceil(homeLift + 48)
    );
    bufferW = w + 2 * panMarginPx;
    bufferH = h + 2 * panMarginPx;

    // Wider FOV on the large buffer so the *center* w×h crop matches BASE_FOV
    const baseFovRad = THREE.MathUtils.degToRad(BASE_FOV);
    camera.fov =
      (2 *
        Math.atan(Math.tan(baseFovRad / 2) * (bufferH / h)) *
        180) /
      Math.PI;
    camera.aspect = bufferW / bufferH;
    camera.updateProjectionMatrix();

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
    renderer.setSize(bufferW, bufferH, false);
    if (starfield?.material) {
      starfield.material.size = starPointSize();
    }

    canvas.style.position = "absolute";
    canvas.style.width = `${bufferW}px`;
    canvas.style.height = `${bufferH}px`;
    canvas.style.left = `${-panMarginPx}px`;
    canvas.style.top = `${-panMarginPx}px`;
    applyCanvasPanTransform();

    homeDist = computeHomeDistance(w, h);
    if (atHome) {
      if (orbiting) {
        // Keep yaw; iOS viewport resize would otherwise snap face-on
        homeLiftY = homeScreenOffsetY();
        applyCanvasPanTransform();
        readSpherical();
        spherical.radius = homeDist;
        writeCamera();
        syncSun();
        prevCamDist = homeDist;
      } else {
        applyHomeFraming();
      }
    } else setCamDist(homeDist * zoomFrac);
  }

  function resetView() {
    camera.far = 200;
    homeDist = computeHomeDistance(
      width || window.innerWidth,
      height || window.innerHeight
    );
    applyHomeFraming();
  }

  // —— Touch + pointer: 2fs pans the canvas (CSS) so movement is always visible ——

  function isFormControl(el) {
    // Also ignore map picker / Leaflet so UI dialogs receive touch
    return !!(
      el &&
      el.closest &&
      el.closest(
        "input,button,select,textarea,a,label,#loc-dialog,.leaflet-container,.loc-dialog,#fact-sheet,.cycle,.slider-track,.cycle-controls"
      )
    );
  }

  function touchPair(list) {
    if (!list || list.length < 2) return null;
    const a = list[0];
    const b = list[1];
    return {
      midX: (a.clientX + b.clientX) / 2,
      midY: (a.clientY + b.clientY) / 2,
      span: Math.max(
        Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        1
      ),
    };
  }

  function fireTapIfAny(gesture) {
    if (!gesture || gesture.moved) return;
    if (Date.now() - gesture.t0 > TAP_MAX_MS) return;
    const x = Number.isFinite(gesture.sx) ? gesture.sx : gesture.x;
    const y = Number.isFinite(gesture.sy) ? gesture.sy : gesture.y;
    if (typeof onTap === "function") onTap();
  }

  function onTouchStart(e) {
    if (e.touches.length === 1 && isFormControl(e.target)) return;
    e.preventDefault();
    if (e.touches.length >= 2) {
      twoFinger = touchPair(e.touches);
      oneFinger = null;
    } else if (e.touches.length === 1) {
      twoFinger = null;
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      oneFinger = { x, y, sx: x, sy: y, t0: Date.now(), moved: false };
    }
  }

  function onTouchMove(e) {
    if (e.touches.length === 0) return;
    if (e.touches.length === 1 && isFormControl(e.target) && !oneFinger) return;
    e.preventDefault();

    if (e.touches.length >= 2) {
      const now = touchPair(e.touches);
      if (!now) return;
      if (!twoFinger) {
        twoFinger = now;
        return;
      }
      // 2fs = pan
      panCamera(now.midX - twoFinger.midX, now.midY - twoFinger.midY);
      // Pinch = zoom (full-screen canvas, no L/R letterbox from CSS)
      const ratio = now.span / twoFinger.span;
      if (Math.abs(Math.log(ratio)) > PINCH_EPS) {
        setCamDist(camDist() / Math.pow(Math.max(ratio, 0.05), PINCH_POWER));
      }
      twoFinger = now;
      return;
    }

    if (oneFinger && e.touches.length === 1) {
      const t = e.touches[0];
      const fromStart = Math.hypot(t.clientX - oneFinger.sx, t.clientY - oneFinger.sy);
      if (fromStart > TAP_SLOP_PX) oneFinger.moved = true;
      // Don't orbit until past tap slop (keeps tap clean)
      if (!oneFinger.moved) return;
      const dx = t.clientX - oneFinger.x;
      const dy = t.clientY - oneFinger.y;
      const h = Math.max(height, 1);
      const dist = camDist();
      const z = THREE.MathUtils.clamp(
        (dist - MIN_DIST) / Math.max(homeDist - MIN_DIST, 0.01),
        0,
        1
      );
      const speed = THREE.MathUtils.lerp(0.28, 0.55, z * z);
      readSpherical();
      spherical.theta -= (2 * Math.PI * dx * speed) / h;
      spherical.phi -= (2 * Math.PI * dy * speed) / h;
      writeCamera();
      oneFinger.x = t.clientX;
      oneFinger.y = t.clientY;
    }
  }

  function onTouchEnd(e) {
    if (e.touches.length >= 2) {
      twoFinger = touchPair(e.touches);
      oneFinger = null;
    } else if (e.touches.length === 1) {
      twoFinger = null;
      const x = e.touches[0].clientX;
      const y = e.touches[0].clientY;
      oneFinger = { x, y, sx: x, sy: y, t0: Date.now(), moved: false };
    } else {
      fireTapIfAny(oneFinger);
      twoFinger = null;
      oneFinger = null;
    }
  }

  // Pointer multi-touch (same path as touch)
  const ptrs = new Map();
  let ptrTwo = null;

  function ptrPair() {
    if (ptrs.size < 2) return null;
    const pts = [...ptrs.values()];
    const a = pts[0];
    const b = pts[1];
    return {
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      span: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1),
    };
  }

  function onPtrDown(e) {
    if (e.pointerType === "mouse") return;
    if (isFormControl(e.target)) return;
    e.preventDefault();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2) {
      ptrTwo = ptrPair();
      oneFinger = null;
    }
  }

  function onPtrMove(e) {
    if (!ptrs.has(e.pointerId)) return;
    e.preventDefault();
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size >= 2) {
      const now = ptrPair();
      if (!now) return;
      if (!ptrTwo) {
        ptrTwo = now;
        return;
      }
      panCamera(now.midX - ptrTwo.midX, now.midY - ptrTwo.midY);
      const ratio = now.span / ptrTwo.span;
      if (Math.abs(Math.log(ratio)) > PINCH_EPS) {
        setCamDist(camDist() / Math.pow(Math.max(ratio, 0.05), PINCH_POWER));
      }
      ptrTwo = now;
    }
  }

  function onPtrUp(e) {
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) ptrTwo = null;
  }

  let mouseMode = null;
  let mouseLast = null;
  let mouseGesture = null;

  function onMouseDown(e) {
    if (isFormControl(e.target)) return;
    if (e.button === 0 && !e.shiftKey) mouseMode = "orbit";
    else if (e.button === 0 && e.shiftKey) mouseMode = "pan";
    else if (e.button === 2) {
      mouseMode = "pan";
      e.preventDefault();
    } else return;
    mouseLast = { x: e.clientX, y: e.clientY };
    mouseGesture = {
      sx: e.clientX,
      sy: e.clientY,
      t0: Date.now(),
      moved: false,
    };
    window.addEventListener("mousemove", onMouseMove, { passive: false });
    window.addEventListener("mouseup", onMouseUp);
  }

  function onMouseMove(e) {
    if (!mouseLast || !mouseMode) return;
    e.preventDefault();
    if (mouseGesture) {
      const fromStart = Math.hypot(
        e.clientX - mouseGesture.sx,
        e.clientY - mouseGesture.sy
      );
      if (fromStart > TAP_SLOP_PX) mouseGesture.moved = true;
      if (!mouseGesture.moved) return;
    }
    const dx = e.clientX - mouseLast.x;
    const dy = e.clientY - mouseLast.y;
    mouseLast = { x: e.clientX, y: e.clientY };
    if (mouseMode === "pan") {
      panCamera(dx, dy);
    } else {
      const h = Math.max(height, 1);
      readSpherical();
      spherical.theta -= (2 * Math.PI * dx * 0.5) / h;
      spherical.phi -= (2 * Math.PI * dy * 0.5) / h;
      writeCamera();
    }
  }

  function onMouseUp() {
    fireTapIfAny(mouseGesture);
    mouseMode = null;
    mouseLast = null;
    mouseGesture = null;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
  }

  function onWheel(e) {
    if (isFormControl(e.target)) return;
    e.preventDefault();
    setCamDist(camDist() * Math.exp(e.deltaY * WHEEL_DOLLY));
  }

  function onContextMenu(e) {
    e.preventDefault();
  }

  const cap = { passive: false, capture: true };
  window.addEventListener("touchstart", onTouchStart, cap);
  window.addEventListener("touchmove", onTouchMove, cap);
  window.addEventListener("touchend", onTouchEnd, { capture: true });
  window.addEventListener("touchcancel", onTouchEnd, { capture: true });
  window.addEventListener("pointerdown", onPtrDown, cap);
  window.addEventListener("pointermove", onPtrMove, cap);
  window.addEventListener("pointerup", onPtrUp, { capture: true });
  window.addEventListener("pointercancel", onPtrUp, { capture: true });
  surface.addEventListener("mousedown", onMouseDown);
  surface.addEventListener("wheel", onWheel, { passive: false });
  surface.addEventListener("contextmenu", onContextMenu);
  canvas.style.touchAction = "none";
  surface.style.touchAction = "none";
  document.documentElement.style.touchAction = "none";
  document.body.style.touchAction = "none";



  function setOrbiting(on) {
    orbiting = !!on;
    if (!orbiting) lastOrbitMs = 0;
    return orbiting;
  }

  function isOrbiting() {
    return orbiting;
  }

  function animate(now) {
    if (disposed) return;
    animId = requestAnimationFrame(animate);
    if (orbiting) {
      const t = typeof now === "number" ? now : performance.now();
      if (!lastOrbitMs) lastOrbitMs = t;
      const dt = Math.min(0.05, (t - lastOrbitMs) / 1000);
      lastOrbitMs = t;
      if (dt > 0) {
        readSpherical();
        spherical.theta -= ORBIT_RAD_PER_SEC * dt;
        writeCamera();
      }
    }
    syncSun();
    updateAtmosphereLight();
    renderer.render(scene, camera);
  }


  fetch("surface.json")
    .then((r) => r.json())
    .then((j) => {
      if (!j || !Number.isFinite(Number(j.l0)) || !j.anchor) return;
      const t = Date.parse(j.anchor);
      if (!Number.isFinite(t)) return;
      surfaceAnchor = {
        t,
        l0: Number(j.l0),
        rotationDays: Number(j.rotationDays) || 27.2753,
      };
      applyEphemeris();
    })
    .catch(() => {});

  applyEphemeris();
  loadLow();
  fitToHost();
  applyHomeFraming();
  animate();

  return {
    resize,
    fitToHost,
    resetView,
    setObserver,
    setTime,
    setOrbiting,
    isOrbiting,
    getPhaseInfo,
    getObserver,
    isReady: () => ready,
    dispose() {
      disposed = true;
      orbiting = false;
      cancelAnimationFrame(animId);
      window.removeEventListener("touchstart", onTouchStart, true);
      window.removeEventListener("touchmove", onTouchMove, true);
      window.removeEventListener("touchend", onTouchEnd, true);
      window.removeEventListener("touchcancel", onTouchEnd, true);
      window.removeEventListener("pointerdown", onPtrDown, true);
      window.removeEventListener("pointermove", onPtrMove, true);
      window.removeEventListener("pointerup", onPtrUp, true);
      window.removeEventListener("pointercancel", onPtrUp, true);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      surface.removeEventListener("mousedown", onMouseDown);
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("contextmenu", onContextMenu);
      if (atmosphere) {
        sunGroup.remove(atmosphere);
        atmosphere.geometry.dispose();
        atmosphereMat?.dispose();
        atmosphere = null;
        atmosphereMat = null;
      }
      if (mesh) {
        mesh.geometry.dispose();
        material?.map?.dispose();
        material?.normalMap?.dispose();
        material?.dispose();
      }
      if (starfield) {
        starfield.geometry?.dispose();
        starfield.material?.map?.dispose();
        starfield.material?.dispose();
        starfield.userData.starTexture?.dispose();
      }
      renderer.dispose();
    },
  };
}
