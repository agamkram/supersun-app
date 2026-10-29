/**
 * Hi-res Sun — AIA 171 Carrington loop on a starfield.
 * 1-finger drag: scrub Carrington frames (works during Orbit too)
 * Orbit: slow camera yaw (~100s) + even face beats; When tracks the loop.
 * 2fs pan · pinch zoom · Live/home reset
 */
import * as THREE from "three";

const RADIUS = 1;
/** Plate width vs host width. 1 = L/R edges on the screen edges (width-only fit). */
const HOME_FILL = 1.0;
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
  return isTabletDisplay() ? 4 : 1.5;
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

/** Full-disk AIA 171 loop — JPEG frames (snappy scrub) on the starfield. */
const MOVIE = {
  meta: "frames.json?v=158",
  poster: "carrington-171-poster.jpg?v=158",
  frameUrl: (i) => `frames/${String(i).padStart(4, "0")}.webp?v=158`,
  /** World size of the square AIA plate; home fits this to the screen. */
  plane: 2.35,
  /** Plate brightness (toneMapped is off, so gain lives here). */
  gain: 1.55,
  durationSec: 12,
  /** Bake window — overwritten from frames.json start/end when meta loads. */
  t0: Date.parse("2026-09-14T00:00:00Z"),
  t1: Date.parse("2026-10-11T00:00:00Z"),
};

/**
 * Legacy flame shell (off in movie mode). Kept so ?flame still compiles.
 */
const FLAME_TRY = 32;
const ATMO_HEIGHT = 1.18;
const ATMO_FADE = 0.75;
const ATMO_INTENSITY = 0.85;
const ATMO_COLOR = new THREE.Color(0xffc04a);

/** Family aimed at the real corona photo — not random novelty presets. */
const FLAME_PATTERNS = [
  { id: 0, name: "Filaments" },
  { id: 1, name: "Boil" },
  { id: 2, name: "Streamers" },
  { id: 3, name: "Loops" },
  { id: 4, name: "Grain" },
];

const FLAME_DEFAULTS = {
  pattern: 0,
  intensity: ATMO_INTENSITY,
};

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
uniform float uTime;
uniform float uPattern;
varying vec3 vWorldPos;

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  v += a * vnoise(p); p = p * 2.03 + vec2(17.0, 9.0); a *= 0.5;
  v += a * vnoise(p); p = p * 2.03 + vec2(17.0, 9.0); a *= 0.5;
  v += a * vnoise(p); p = p * 2.03 + vec2(17.0, 9.0); a *= 0.5;
  v += a * vnoise(p);
  return v;
}

void main() {
  vec3 rd = normalize(vWorldPos - cameraPosition);
  vec3 oc = cameraPosition - uPlanetCenter;
  float along = dot(oc, rd);
  float dist = length(oc - rd * along);
  float span = max(uAtmoRadius - uPlanetRadius, 1e-4);
  float h = clamp((dist - uPlanetRadius) / span, 0.0, 1.0);

  vec3 limb = oc - rd * along;
  float ang = atan(limb.y, limb.x);
  vec2 ring = vec2(cos(ang), sin(ang));
  float P = clamp(floor(uPattern + 0.5), 0.0, 4.0);

  // Always-on limb shell — if this is missing, the shader failed.
  float base = pow(max(1.0 - h, 0.0), uFadePower);

  float body = base;
  float tongue = 0.5;
  float pulse = 1.0;
  vec3 tipCol = vec3(1.0, 0.42, 0.08);

  if (P < 0.5 || P >= 1.5) {
    // Filament family (0 Filaments, 2 Streamers, 3 Loops, 4 Grain).
    float stretchA = 13.0;
    float loopAmt = 1.0;
    float grainAmt = 0.55;
    float tScale = 0.16;
    if (P >= 1.5 && P < 2.5) { stretchA = 18.0; loopAmt = 0.25; grainAmt = 0.3; tScale = 0.12; }
    if (P >= 2.5 && P < 3.5) { stretchA = 10.0; loopAmt = 1.85; grainAmt = 0.4; tScale = 0.14; tipCol = vec3(1.0, 0.55, 0.12); }
    if (P >= 3.5) { stretchA = 14.0; loopAmt = 0.7; grainAmt = 1.1; tScale = 0.2; }

    float t = uTime * tScale;
    float active = smoothstep(0.38, 0.7, fbm(vec2(ang * 1.15, t * 0.06)));
    float warp = fbm(vec2(ang * 2.2, h * 0.9 + t * 0.08)) - 0.5;
    float loopBend = loopAmt * active * (1.0 - h) * sin(ang * 5.5 + t * 0.15);
    float fil = fbm(vec2(ang * stretchA + warp * 1.4 + loopBend * 2.5, h * 1.6 - t * 0.28));
    fil = pow(max(fil, 0.0), 1.55);
    float fil2 = fbm(vec2(ang * stretchA * 1.7 - warp, h * 2.4 - t * 0.45));
    fil2 = pow(max(fil2, 0.0), 1.9);
    float grain = 1.0 + grainAmt * (fbm(vec2(ang * 22.0 + t * 0.7, h * 12.0 - t * 1.3)) - 0.5);

    // Soft shell always present; filaments carve brightness and ragged reach.
    float reach = mix(0.75, 1.15, clamp(0.4 * fil + 0.4 * active, 0.0, 1.0));
    float env = pow(clamp(1.0 - h / max(reach, 1e-3), 0.0, 1.0), mix(1.2, 0.55, fil));
    body = max(base * 0.55, env * (0.35 + 0.65 * fil + 0.35 * fil2 * active) * grain);
    body *= mix(0.92, 1.35, active);
    tongue = clamp(0.45 * fil + 0.55 * active, 0.0, 1.0);
    pulse = 0.94 + 0.1 * active;
  } else {
    // 1 Boil — A/B only.
    float t = uTime * 0.4;
    float w1 = fbm(ring * 2.2 + vec2(t * 0.7, h * 2.5));
    float w2 = fbm(ring * 3.8 - vec2(t * 0.55, h * 1.8));
    vec2 q = ring * 3.0 + vec2(w1 - 0.5, w2 - 0.5) * 1.8;
    float field = fbm(q + vec2(h * 3.5 - t * 1.4, t * 0.35));
    tongue = field;
    body = max(base * 0.5, pow(max(1.0 - h, 0.0), mix(0.6, 1.8, 1.0 - field)) * (0.45 + 0.7 * field));
    pulse = 0.85 + 0.25 * (w1 - 0.5);
  }

  float hot = pow(max(1.0 - h, 0.0), 1.6);
  vec3 col = mix(tipCol, uColor, clamp(0.3 + 0.7 * hot, 0.0, 1.0));
  col = mix(col, vec3(1.0, 0.92, 0.72), hot * tongue * 0.3);

  float glow = body * pulse * uIntensity;
  // Hard floor so the corona cannot disappear.
  glow = max(glow, base * uIntensity * 0.35);
  gl_FragColor = vec4(col * glow, 1.0);
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
    onTap = null,
    onOrbitChange = null,
    onScrub = null,
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
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.debug.checkShaderErrors = true;
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
  let plateCanvas = null;
  let plateCtx = null;
  let plateTex = null;
  /** @type {(HTMLImageElement|null)[]} */
  let frameImgs = [];
  /** @type {(Promise<HTMLImageElement|null>|null)[]} in-flight loads — never restart. */
  let framePromises = [];
  let frameCount = 0;
  let frameIndex = -1;
  let moviePhase01 = 0;
  /** Visual Carrington phase while Orbit runs (also drives When). */
  let orbitPhase01 = 0;
  let ready = false;
  let disposed = false;
  let animId = 0;
  /** Orbit = advance Carrington frames on a fixed face-on disk. */
  let orbiting = false;
  /** True after the playhead frame has painted. */
  let orbitFaceReady = false;
  /** Integer plate while Orbit runs. Cuts are index steps, not phase rounding. */
  let orbitFrame = 0;
  /** Seconds accumulated toward the next plate. */
  let orbitHold = 0;
  /** Face clock runs only after the next plates are already decoded. */
  let orbitClock = false;
  /** Plates that must be decoded before the first cut. */
  const ORBIT_PREROLL = 24;
  /** Keep this many plates ahead of the one on screen. */
  const ORBIT_LOOKAHEAD = 120;
  /** Warm plates around the scrub target so drag stays continuous. */
  const SCRUB_LOOKAHEAD = 24;
  /** Cap in-flight JPEG fetches — blasting 120 Image()s starves the playhead. */
  const FRAME_LOAD_CONC = 6;
  let frameLoadActive = 0;
  /** @type {number[]} */
  const frameLoadQueue = [];
  /** Redraw when something changed; skip GPU work while parked and still. */
  let needsDraw = true;
  function requestDraw() {
    needsDraw = true;
  }
  /**
   * Camera / starfield yaw — locked at 0.75× of the old 100s turn (Dir / prograde).
   * Stars drift opposite the Sun's left→right face motion.
   */
  const ORBIT_YAW_SEC = 100 / 0.75;
  /**
   * Face period during Orbit (seconds per full loop).
   * 649 plates @ 30s ≈ 46ms/cut (stutters). 60s ≈ 92ms — same pace as the old 2h@30s bake.
   */
  let orbitFaceSec = 60;
  let lastAnimMs = 0;
  /** Flick inertia: phase units (0–1) per second. */
  let scrubVel = 0;
  /** Mild coast only — old 1.8 turns/s felt like many Carringtons. */
  const SCRUB_FRICTION = 6.0;
  const SCRUB_FLICK_MAX = 0.22;
  let phaseDirty = false;
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

  function configureColor(tex, { video = false } = {}) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;
    tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
    tex.magFilter = THREE.LinearFilter;
    if (video) {
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
    } else {
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.generateMipmaps = true;
    }
    tex.needsUpdate = true;
  }

  function buildMovieMesh(map) {
    if (mesh) {
      sunGroup.remove(mesh);
      mesh.geometry.dispose();
      mesh = null;
    }
    if (material) {
      material.dispose();
      material = null;
    }

    map.colorSpace = THREE.NoColorSpace;
    map.needsUpdate = true;
    material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uGain: { value: MOVIE.gain },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform float uGain;
        varying vec2 vUv;
        void main() {
          vec3 col = texture2D(uMap, vUv).rgb * uGain;
          float luma = max(col.r, max(col.g, col.b));
          // Clear faint outer corona so stars can sit closer to the bright disk.
          float a = smoothstep(0.028, 0.07, luma);
          if (a < 0.0015) discard;
          gl_FragColor = vec4(col * a, a);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      blending: THREE.NormalBlending,
      premultipliedAlpha: true,
    });

    const side = MOVIE.plane;
    mesh = new THREE.Mesh(new THREE.PlaneGeometry(side, side), material);
    mesh.frustumCulled = false;
    sunGroup.add(mesh);
    applyEphemeris();
  }

  function bindPlateMap() {
    if (!plateTex) return;
    plateTex.needsUpdate = true;
    if (!mesh || !material?.uniforms?.uMap) {
      buildMovieMesh(plateTex);
      return;
    }
    material.uniforms.uMap.value = plateTex;
  }

  const flameParams = { ...FLAME_DEFAULTS };

  function applyFlameUniforms() {
    if (!atmosphereMat?.uniforms) return;
    const u = atmosphereMat.uniforms;
    if (u.uPattern) u.uPattern.value = flameParams.pattern;
    if (u.uIntensity) u.uIntensity.value = flameParams.intensity;
  }

  function setFlameParams( partial ) {
    if (!partial || typeof partial !== "object") return getFlameParams();
    if (Number.isFinite(Number(partial.pattern))) {
      flameParams.pattern = Math.max(
        0,
        Math.min(FLAME_PATTERNS.length - 1, Math.round(Number(partial.pattern)))
      );
    }
    if (Number.isFinite(Number(partial.intensity))) {
      flameParams.intensity = Number(partial.intensity);
    }
    applyFlameUniforms();
    return getFlameParams();
  }

  function getFlameParams() {
    const id = Math.max(
      0,
      Math.min(FLAME_PATTERNS.length - 1, Math.round(flameParams.pattern))
    );
    const meta = FLAME_PATTERNS[id] || FLAME_PATTERNS[0];
    return {
      try: FLAME_TRY,
      pattern: id,
      name: meta.name,
      intensity: flameParams.intensity,
      patterns: FLAME_PATTERNS.map((p) => p.name),
    };
  }

  function ensureAtmosphere() {
    if (atmosphere) return;
    atmosphereMat = new THREE.ShaderMaterial({
      vertexShader: ATMO_VERTEX,
      fragmentShader: ATMO_FRAGMENT,
      uniforms: {
        uColor: { value: ATMO_COLOR.clone() },
        uIntensity: { value: flameParams.intensity },
        uFadePower: { value: ATMO_FADE },
        uPlanetCenter: { value: new THREE.Vector3() },
        uPlanetRadius: { value: RADIUS },
        uAtmoRadius: { value: RADIUS * ATMO_HEIGHT },
        uTime: { value: 0 },
        uPattern: { value: flameParams.pattern },
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
    applyFlameUniforms();
  }

  function updateAtmosphereLight(nowMs) {
    if (!atmosphereMat || !atmosphere) return;
    sunGroup.getWorldPosition(_atmoCenter);
    sunGroup.getWorldScale(_atmoScale);
    const g = _atmoScale.x;
    atmosphereMat.uniforms.uPlanetCenter.value.copy(_atmoCenter);
    atmosphereMat.uniforms.uPlanetRadius.value = RADIUS * g;
    atmosphereMat.uniforms.uAtmoRadius.value = RADIUS * ATMO_HEIGHT * g;
    const t = typeof nowMs === "number" ? nowMs : performance.now();
    atmosphereMat.uniforms.uTime.value = t * 0.001;
    // Re-push knobs every frame so a pre-mesh tweak still lands.
    applyFlameUniforms();
  }

  /** Looping phase (Orbit / flick). Note: `1 % 1 === 0` in JS. */
  function wrapPhase01(p) {
    p = Number(p) || 0;
    p = p % 1;
    if (p < 0) p += 1;
    return p;
  }

  /** Parked phase — keeps 1.0 at the end (no snap to 0). */
  function clampPhase01(p) {
    return THREE.MathUtils.clamp(Number(p) || 0, 0, 1);
  }

  function phaseToDate(p) {
    const span = Math.max(MOVIE.t1 - MOVIE.t0, 1);
    return new Date(MOVIE.t0 + clampPhase01(p) * span);
  }

  function dateToPhase(date) {
    const t = date instanceof Date ? date.getTime() : Date.parse(date);
    if (!Number.isFinite(t)) return moviePhase01;
    const span = Math.max(MOVIE.t1 - MOVIE.t0, 1);
    return THREE.MathUtils.clamp((t - MOVIE.t0) / span, 0, 1);
  }

  function ensurePlate(size = 1024) {
    if (plateCanvas && plateCanvas.width === size) return false;
    plateCanvas = document.createElement("canvas");
    plateCanvas.width = size;
    plateCanvas.height = size;
    plateCtx = plateCanvas.getContext("2d", { alpha: false });
    plateCtx.fillStyle = "#000";
    plateCtx.fillRect(0, 0, size, size);
    if (plateTex) plateTex.dispose();
    plateTex = new THREE.CanvasTexture(plateCanvas);
    configureColor(plateTex, { video: true });
    plateTex.colorSpace = THREE.NoColorSpace;
    frameIndex = -1;
    return true;
  }

  function paintImageToPlate(img) {
    // Fallback path (placeholder). Orbit/scrub bind the Image directly.
    if (!plateCtx || !plateTex || !img?.naturalWidth) return false;
    plateCtx.drawImage(img, 0, 0, plateCanvas.width, plateCanvas.height);
    plateTex.image = plateCanvas;
    plateTex.needsUpdate = true;
    bindPlateMap();
    return true;
  }

  function frameReady(i) {
    const img = frameImgs[i];
    return !!(img && img.complete && img.naturalWidth > 0);
  }

  /** How many loop frames are decoded and ready to paint. */
  function getFrameLoadStats() {
    const total = frameCount | 0;
    let readyCount = 0;
    for (let i = 0; i < total; i++) {
      if (frameReady(i)) readyCount += 1;
    }
    return {
      ready: readyCount,
      total,
      loading: frameLoadActive,
      queued: frameLoadQueue.length,
    };
  }

  function paintFrameIndex(i, force = false) {
    if (!plateTex) return false;
    const n = Math.max(frameCount, 1);
    const idx = ((Math.round(i) % n) + n) % n;
    if (!frameReady(idx)) return false;
    if (!force && idx === frameIndex) return true;
    const img = frameImgs[idx];
    // Bind the decoded JPEG directly — skip canvas blit + second upload.
    plateTex.image = img;
    plateTex.colorSpace = THREE.NoColorSpace;
    plateTex.needsUpdate = true;
    bindPlateMap();
    frameIndex = idx;
    requestDraw();
    return true;
  }

  /** Closest decoded plate to `want` (bidirectional). -1 if none yet. */
  function nearestReadyFrame(want) {
    const n = frameCount | 0;
    if (n < 1) return -1;
    const idx = ((Math.round(want) % n) + n) % n;
    if (frameReady(idx)) return idx;
    for (let d = 1; d < n; d++) {
      const a = (idx + d) % n;
      const b = (idx - d + n) % n;
      if (frameReady(a)) return a;
      if (frameReady(b)) return b;
    }
    return -1;
  }

  /** Priority-load the scrub target and a small window around it. */
  function ensureScrubAround(idx) {
    const n = frameCount;
    if (n < 1) return;
    const center = ((idx % n) + n) % n;
    loadFrame(center, { priority: true });
    const ahead = Math.min(SCRUB_LOOKAHEAD, n - 1);
    for (let k = 1; k <= ahead; k++) {
      const a = (center + k) % n;
      const b = (center - k + n) % n;
      if (!frameReady(a)) loadFrame(a);
      if (!frameReady(b)) loadFrame(b);
    }
    pumpFrameLoads();
  }

  function showFrameAtPhase(p, force = false) {
    const n = Math.max(frameCount, 1);
    // clamp (not wrap): phase 1.0 is the last frame, not a snap to 0.
    const idx = Math.min(n - 1, Math.max(0, Math.round(clampPhase01(p) * (n - 1))));
    if (paintFrameIndex(idx, force)) return true;
    // Gap in the loop — keep the disk moving with the nearest ready plate
    // while the exact target jumps the load queue.
    const near = nearestReadyFrame(idx);
    if (near >= 0) paintFrameIndex(near, force);
    ensureScrubAround(idx);
    return false;
  }

  function loadMovie() {
    ensurePlate(1024);
    buildMovieMesh(plateTex);
    // Stay hidden (no poster) until the Orbit start plate paints — avoids
    // poster → Live → wrap-to-0 as three different opening faces.

    fetch(MOVIE.meta)
      .then((r) => r.json())
      .then((meta) => {
        if (disposed || !meta) return;
        frameCount = Math.max(1, Number(meta.count) || 0);
        const size = Number(meta.size) || 1024;
        if (Number.isFinite(Number(meta.durationSec))) {
          MOVIE.durationSec = Number(meta.durationSec);
        }
        // Single source of truth for Live/scrub ↔ plate mapping.
        const t0 = Date.parse(meta.start);
        const t1 = Date.parse(meta.end);
        if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) {
          MOVIE.t0 = t0;
          MOVIE.t1 = t1;
          // Re-map parked Live phase now that the real window is known.
          moviePhase01 = dateToPhase(new Date());
          when = phaseToDate(moviePhase01);
          applyEphemeris();
        }
        ensurePlate(size);
        bindPlateMap();
        frameImgs = new Array(frameCount).fill(null);
        framePromises = new Array(frameCount).fill(null);
        // Boot always opens on plate 0 (start of the baked turn).
        const bootIdx = 0;
        orbitFrame = bootIdx;
        // Forward buffer only — full-ring prefetch starved Orbit on 649 plates.
        ensureOrbitAhead();
        const reveal = () => {
          if (disposed) return;
          if (!paintFrameIndex(bootIdx, true)) return;
          if (!ready) {
            ready = true;
            if (typeof onReady === "function") onReady();
          }
          if (typeof onQuality === "function") onQuality("frames");
        };
        loadFrame(bootIdx).then(reveal);
      })
      .catch(() => {});
  }

  function pumpFrameLoads() {
    while (frameLoadActive < FRAME_LOAD_CONC && frameLoadQueue.length) {
      const idx = frameLoadQueue.shift();
      if (idx == null) continue;
      const img = frameImgs[idx];
      if (!img || frameReady(idx)) continue;
      if (typeof img.__beginLoad === "function") img.__beginLoad();
    }
  }

  function loadFrame(i, opts = {}) {
    const idx = i | 0;
    if (idx < 0 || idx >= frameCount) return Promise.resolve(null);
    if (frameImgs[idx]?.complete && frameImgs[idx].naturalWidth) {
      return Promise.resolve(frameImgs[idx]);
    }
    // Reuse the in-flight request — restarting every rAF starved Orbit.
    if (framePromises[idx]) {
      if (opts.priority && frameImgs[idx]?.dataset?.defer === "1") {
        const q = frameLoadQueue.indexOf(idx);
        if (q >= 0) frameLoadQueue.splice(q, 1);
        frameLoadQueue.unshift(idx);
        pumpFrameLoads();
      }
      return framePromises[idx];
    }
    framePromises[idx] = new Promise((resolve) => {
      const img = new Image();
      img.decoding = "async";
      frameImgs[idx] = img;
      let started = false;
      const begin = () => {
        if (started || frameReady(idx)) return;
        started = true;
        delete img.dataset.defer;
        frameLoadActive += 1;
        img.src = MOVIE.frameUrl(idx);
      };
      img.__beginLoad = begin;
      const finish = (value) => {
        if (started) {
          started = false;
          frameLoadActive = Math.max(0, frameLoadActive - 1);
        }
        delete img.__beginLoad;
        if (value) {
          frameImgs[idx] = value;
          if (orbiting && idx === orbitFrame && paintFrameIndex(orbitFrame, true)) {
            orbitFaceReady = true;
          }
        }
        resolve(value);
        pumpFrameLoads();
      };
      img.onload = () => {
        if (typeof img.decode === "function") {
          img.decode().then(() => finish(img)).catch(() => finish(img));
        } else finish(img);
      };
      img.onerror = () => {
        framePromises[idx] = null;
        finish(null);
      };
      if (opts.priority || frameLoadActive < FRAME_LOAD_CONC) {
        begin();
      } else {
        img.dataset.defer = "1";
        frameLoadQueue.push(idx);
      }
    });
    return framePromises[idx];
  }

  /** Kick missing plates ahead of the Orbit playhead (idempotent). */
  function ensureOrbitAhead() {
    const n = frameCount;
    if (n < 1) return;
    const ahead = Math.min(ORBIT_LOOKAHEAD, n);
    // Playhead first, then forward — queue caps concurrency.
    loadFrame(orbitFrame, { priority: true });
    for (let k = 1; k < ahead; k++) {
      const i = (orbitFrame + k) % n;
      if (!frameReady(i)) loadFrame(i);
    }
    pumpFrameLoads();
  }

  /** Sync parked phase + When from the Orbit playhead. */
  function adoptOrbitPhase() {
    syncOrbitPhase();
    moviePhase01 = clampPhase01(orbitPhase01);
    when = phaseToDate(moviePhase01);
  }

  /**
   * Parked Carrington phase (scrub / Live / metrics). While Orbit runs, face
   * follows orbitFrame; setCyclePhase only updates parked metrics.
   */
  function setCyclePhase(p, opts = {}) {
    if (!opts.fromOrbit) scrubVel = 0;
    moviePhase01 = clampPhase01(Number(p) || 0);
    when = phaseToDate(moviePhase01);
    if (orbiting || opts.paint === false) {
      // Park phase + metrics only — leave the visible face alone.
      applyEphemeris();
      return lastPhaseInfo;
    }
    showFrameAtPhase(moviePhase01);
    // If the exact plate isn't up yet, paint nearest (above) and retry on load.
    const n = Math.max(frameCount, 1);
    const idx = Math.min(n - 1, Math.max(0, Math.round(moviePhase01 * (n - 1))));
    if (!frameReady(idx)) {
      loadFrame(idx, { priority: true }).then(() => {
        if (!disposed && !orbiting) showFrameAtPhase(moviePhase01);
      });
    }
    applyEphemeris();
    return lastPhaseInfo;
  }

  /** Full screen width = one Carrington. */
  function scrubSpanPx() {
    return Math.max(width || window.innerWidth || 1, 1);
  }

  /** Drag through the Carrington turn. dx>0 (drag right) advances. Works in Orbit. */
  function scrubMovieByPx(dx, sampleDtMs) {
    if (!Number.isFinite(dx) || dx === 0) return;
    const span = scrubSpanPx();
    const dPhase = dx / span;
    if (orbiting) {
      // Reposition Orbit playhead; clock keeps cutting from here.
      const n = Math.max(frameCount, 1);
      orbitPhase01 = wrapPhase01(orbitPhase01 + dPhase);
      orbitFrame =
        n > 1
          ? Math.min(n - 1, Math.max(0, Math.round(orbitPhase01 * (n - 1))))
          : 0;
      syncOrbitPhase();
      adoptOrbitPhase();
      orbitHold = 0;
      if (!paintFrameIndex(orbitFrame, true)) {
        const near = nearestReadyFrame(orbitFrame);
        if (near >= 0) paintFrameIndex(near, true);
      }
      ensureOrbitAhead();
      phaseDirty = true;
      if (typeof onScrub === "function") onScrub();
      return;
    }
    moviePhase01 = wrapPhase01(moviePhase01 + dPhase);
    when = phaseToDate(moviePhase01);
    showFrameAtPhase(moviePhase01);
    phaseDirty = true;
    if (sampleDtMs > 0) {
      const v = dPhase / (sampleDtMs / 1000);
      scrubVel = THREE.MathUtils.clamp(v, -SCRUB_FLICK_MAX, SCRUB_FLICK_MAX);
    }
    if (typeof onScrub === "function") onScrub();
  }

  function captureSkyPose(date = new Date()) {
    frozenSouthern = observerLat < 0;
    frozenRoll = skyRollRad(observerLat, observerLon, date);
  }

  function applyEphemeris() {
    const phase01 = moviePhase01;
    const l0 = l0Degrees(when);
    // Movie disk billboards to the camera; phase is the frame, not mesh spin.
    const southern = orientLocked ? frozenSouthern : observerLat < 0;
    const skyRoll = orientLocked
      ? frozenRoll
      : skyRollRad(observerLat, observerLon, when);
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
    requestDraw();
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
    return setCyclePhase(dateToPhase(when), opts);
  }

  function getPhaseInfo() {
    return lastPhaseInfo;
  }

  function getObserver() {
    return { lat: observerLat, lon: observerLon };
  }

  /** Baked AIA window (ms). Populated from frames.json. */
  function getMovieWindow() {
    return { t0: MOVIE.t0, t1: MOVIE.t1 };
  }

  /** Map a wall-clock date into the bake window (0…1, clamped). */
  function moviePhase01FromDate(date = new Date()) {
    return dateToPhase(date);
  }

  /** Inverse of moviePhase01FromDate. */
  function dateFromMoviePhase01(phase01) {
    return phaseToDate(phase01);
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
   * Home size: keep the square on screen.
   * Portrait: match plate width to screen width (L/R edges on the sides).
   * Landscape: match plate height to screen height so a wide window
   * does not blow the Sun up to the long side.
   */
  function computeHomeDistance(w, h) {
    const vFov = THREE.MathUtils.degToRad(BASE_FOV);
    const aspect = Math.max(w, 1) / Math.max(h, 1);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    const fitR = MOVIE.plane * 0.5;
    const distW = (fitR * w) / (HOME_FILL * w * Math.tan(hFov / 2));
    const distHt = fitR / Math.tan(vFov / 2);
    return Math.max(distW, distHt, MIN_DIST + 0.2);
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
    // Flat plate at the target — keep near plane clear of the disk.
    const dist = spherical.radius;
    camera.near = Math.max(0.001, dist * 0.25);
    camera.far = Math.max(200, dist + 40);
    camera.updateProjectionMatrix();
  }

  function camDist() {
    return camera.position.distanceTo(target);
  }

  function syncSun() {
    sunGroup.position.copy(target);
    // Keep the full-disk frame facing the camera (corona stays readable).
    if (mesh) mesh.quaternion.copy(camera.quaternion);
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

  /** Same tablet test as the first-paint class in index.html. */
  function syncTabletClass() {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("is-tablet", isTabletDisplay());
  }

  /**
   * iPad bottom-edge lift (CSS px). The metric box uses the same
   * --ipad-gesture-lift, so the Sun and the bottom panel rise together.
   */
  function ipadGestureLiftPx() {
    if (typeof document === "undefined") return 0;
    syncTabletClass();
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--ipad-gesture-lift")
      .trim();
    if (!raw || raw === "0" || raw === "0px") return 0;
    return measureCssLength(raw, 0);
  }

  /** CSS Y so home Sun sits in the upper safe band (above bottom info), not mid-screen. */
  function homeScreenOffsetY() {
    const pads = readHomePadsPx();
    // Safe-band center is above the viewport center when bottom pad > top pad.
    // CSS translateY: negative = content moves up. Extra 3/8" on startup.
    // Gesture lift matches the loc-bar bottom offset (full amount, not half).
    return (pads.top - pads.bottom) / 2 - homeExtraUpPx() + homeLowerBiasPx() - ipadGestureLiftPx();
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
    requestDraw();
  }

  function setCamDist(dist) {
    dist = THREE.MathUtils.clamp(dist, MIN_DIST, Math.max(homeDist, MIN_DIST + 0.2));
    requestDraw();
    // Full un-zoom → home framing (sun edge at screen edge).
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
    requestDraw();

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
    // Window size is the orientation source of truth. After a rotate the
    // host / visualViewport can sit on the *old* size for a frame; taking
    // max() of mixed sources becomes a square and the Sun parks too close.
    const iw = window.innerWidth || document.documentElement.clientWidth || 1;
    const ih = window.innerHeight || document.documentElement.clientHeight || 1;
    let w = iw;
    let h = ih;
    const viewLandscape = iw > ih;
    const host = canvas.parentElement;
    if (host) {
      const rect = host.getBoundingClientRect();
      const hostLandscape = rect.width > rect.height;
      if (rect.width > 0 && rect.height > 0 && hostLandscape === viewLandscape) {
        w = Math.max(w, rect.width);
        h = Math.max(h, rect.height);
      }
      const gap = Math.max(0, ih - rect.bottom);
      if (gap > 0 && gap < 80 && hostLandscape === viewLandscape) h += gap;
    }
    const vv = window.visualViewport;
    if (vv && vv.width > 0 && vv.height > 0) {
      const vvLandscape = vv.width > vv.height;
      if (vvLandscape === viewLandscape) {
        w = Math.max(w, vv.width);
        h = Math.max(h, vv.height, (vv.offsetTop || 0) + vv.height);
      }
    }
    const nextW = Math.max(1, Math.round(w));
    const nextH = Math.max(1, Math.round(h));
    const flipped = width > 0 && height > 0 && nextW > nextH !== width > height;
    resize(nextW, nextH, { forceHome: flipped });
  }

  function applyHomeKeepYaw() {
    homeLiftY = homeScreenOffsetY();
    applyCanvasPanTransform();
    readSpherical();
    spherical.radius = homeDist;
    writeCamera();
    syncSun();
    prevCamDist = homeDist;
  }

  function resize(cssW, cssH, opts = {}) {
    const w = Math.max(1, Math.round(cssW));
    const h = Math.max(1, Math.round(cssH));
    const sameSize = w === width && h === height && bufferW > 0;
    if (sameSize && !opts.forceHome) {
      const atHomeNow = camDist() >= homeDist * 0.97 && target.lengthSq() < 1e-4;
      if (atHomeNow) {
        homeLiftY = homeScreenOffsetY();
        applyCanvasPanTransform();
      }
      return;
    }

    const prevHome = homeDist;
    const dist = camDist();
    const parked = target.lengthSq() < 1e-4;
    const atHome =
      parked &&
      (dist >= prevHome * 0.97 ||
        (opts.forceHome && dist >= computeHomeDistance(w, h) * 0.97));
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
        applyHomeKeepYaw();
      } else {
        applyHomeFraming();
      }
    } else setCamDist(homeDist * zoomFrac);
    getLayoutMetrics();
    requestDraw();
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
        "input,button,select,textarea,a,label,#fact-sheet"
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
      // Don't scrub until past tap slop (keeps tap clean)
      if (!oneFinger.moved) return;
      const nowMs = performance.now();
      const dx = t.clientX - oneFinger.x;
      const dtMs = oneFinger.tMove ? nowMs - oneFinger.tMove : 16;
      scrubMovieByPx(dx, dtMs);
      oneFinger.x = t.clientX;
      oneFinger.y = t.clientY;
      oneFinger.tMove = nowMs;
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
      // No flick coast — stops when you stop.
      scrubVel = 0;
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
    const nowMs = performance.now();
    const dtMs = mouseLast.tMove ? nowMs - mouseLast.tMove : 16;
    mouseLast = { x: e.clientX, y: e.clientY, tMove: nowMs };
    if (mouseMode === "pan") {
      panCamera(dx, dy);
    } else {
      scrubMovieByPx(dx, dtMs);
    }
  }

  function onMouseUp() {
    fireTapIfAny(mouseGesture);
    scrubVel = 0;
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



  function syncOrbitPhase() {
    const n = Math.max(frameCount, 1);
    orbitPhase01 = n > 1 ? orbitFrame / (n - 1) : 0;
  }

  /** True when `count` plates starting at fromIdx are decoded. */
  function orbitAheadReady(fromIdx, count) {
    const n = frameCount;
    if (n < 1) return false;
    const need = Math.min(count, n);
    for (let k = 0; k < need; k++) {
      if (!frameReady((fromIdx + k) % n)) return false;
    }
    return true;
  }

  function primeOrbitFrame() {
    const n = Math.max(frameCount, 1);
    if (frameIndex >= 0) orbitFrame = ((frameIndex % n) + n) % n;
    else {
      orbitFrame = Math.min(
        n - 1,
        Math.max(0, Math.round(clampPhase01(moviePhase01) * (n - 1)))
      );
    }
    orbitHold = 0;
    orbitClock = false;
    syncOrbitPhase();
  }

  function warmOrbitWindow() {
    ensureOrbitAhead();
  }

  function setOrbiting(on, opts = {}) {
    const next = !!on;
    const changed = next !== orbiting;
    orbiting = next;
    scrubVel = 0;
    if (orbiting) {
      const n = Math.max(frameCount, 1);
      const from = Number(opts.fromFrame);
      if (Number.isFinite(from) && n > 0) {
        orbitFrame = ((Math.round(from) % n) + n) % n;
        orbitHold = 0;
        orbitClock = false;
        syncOrbitPhase();
      } else {
        // Continue from the face already on screen. Clock waits for preroll.
        primeOrbitFrame();
      }
      orbitFaceReady = paintFrameIndex(orbitFrame, true);
      warmOrbitWindow();
      // Start cutting as soon as the short preroll is already warm.
      if (orbitAheadReady(orbitFrame, ORBIT_PREROLL)) {
        orbitClock = true;
        orbitHold = 0;
      }
      // When tracks the face from the first Orbit plate.
      adoptOrbitPhase();
      applyEphemeris();
    } else {
      orbitFaceReady = false;
      orbitClock = false;
      orbitHold = 0;
      // Stay on the Orbit face — adopt it as the new parked phase.
      adoptOrbitPhase();
      paintFrameIndex(orbitFrame, true);
      applyEphemeris();
    }
    if (changed && typeof onOrbitChange === "function") onOrbitChange(orbiting);
    return orbiting;
  }

  /** True when the plate is showing the parked (scrub/Live) phase frame. */
  function isParkedFramePainted() {
    if (frameCount < 1 || frameIndex < 0) return false;
    const n = Math.max(frameCount, 1);
    const want = Math.min(
      n - 1,
      Math.max(0, Math.round(clampPhase01(moviePhase01) * (n - 1)))
    );
    return frameIndex === want && frameReady(want);
  }

  function isFramePainted(i) {
    const idx = i | 0;
    return frameIndex === idx && frameReady(idx);
  }

  function isOrbiting() {
    return orbiting;
  }

  function animate(now) {
    if (disposed) return;
    animId = requestAnimationFrame(animate);
    const t = typeof now === "number" ? now : performance.now();
    if (!lastAnimMs) lastAnimMs = t;
    const dt = Math.min(0.05, (t - lastAnimMs) / 1000);
    lastAnimMs = t;
    let advanced = false;
    if (orbiting && dt > 0) {
      // Stars: slow (~100s), continuous. Face: equal holds, one plate per beat.
      // When / metrics follow orbitPhase01.
      readSpherical();
      spherical.theta += ((2 * Math.PI) / ORBIT_YAW_SEC) * dt;
      writeCamera();
      const n = frameCount;
      if (n > 0) {
        ensureOrbitAhead();
        if (!orbitClock) {
          if (paintFrameIndex(orbitFrame)) orbitFaceReady = true;
          if (orbitAheadReady(orbitFrame, ORBIT_PREROLL)) {
            orbitClock = true;
            orbitHold = 0;
          }
        } else {
          const period = Math.max(orbitFaceSec, 1) / n;
          orbitHold += dt;
          // One plate per beat, never skip (skips read as stutter).
          if (orbitHold >= period) {
            const next = (orbitFrame + 1) % n;
            if (frameReady(next)) {
              orbitHold -= period;
              if (orbitHold >= period) orbitHold = 0;
              orbitFrame = next;
              adoptOrbitPhase();
              paintFrameIndex(orbitFrame);
              ensureOrbitAhead();
              phaseDirty = true;
            } else {
              orbitHold = period;
              loadFrame(next);
            }
          }
        }
      }
    } else if (!orbiting && scrubVel !== 0 && dt > 0) {
      moviePhase01 = wrapPhase01(moviePhase01 + scrubVel * dt);
      when = phaseToDate(moviePhase01);
      const prev = frameIndex;
      showFrameAtPhase(moviePhase01);
      advanced = frameIndex !== prev;
      const damp = Math.exp(-SCRUB_FRICTION * dt);
      scrubVel *= damp;
      if (Math.abs(scrubVel) < 0.02) scrubVel = 0;
    }
    if (phaseDirty || advanced) {
      phaseDirty = false;
      applyEphemeris();
    }
    syncSun();
    const moving = orbiting || scrubVel !== 0;
    if (moving || needsDraw) {
      needsDraw = false;
      renderer.render(scene, camera);
    }
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
  loadMovie();
  fitToHost();
  applyHomeFraming();
  animate();

  /** Host CSS px vs projected AIA plate edges (for sizing checks). */
  function getLayoutMetrics() {
    const host = canvas.parentElement;
    const hostRect = host?.getBoundingClientRect?.() || {
      width,
      height,
      left: 0,
      top: 0,
    };
    const canvasRect = canvas.getBoundingClientRect();
    let plateLeft = null;
    let plateRight = null;
    let plateCssW = null;
    if (mesh && camera) {
      mesh.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      const half = MOVIE.plane * 0.5;
      const ndcToHostX = (ndcX) => {
        const xCanvas = (ndcX * 0.5 + 0.5) * canvasRect.width + canvasRect.left;
        return xCanvas - hostRect.left;
      };
      const left = new THREE.Vector3(-half, 0, 0).applyMatrix4(mesh.matrixWorld);
      const right = new THREE.Vector3(half, 0, 0).applyMatrix4(mesh.matrixWorld);
      left.project(camera);
      right.project(camera);
      plateLeft = ndcToHostX(left.x);
      plateRight = ndcToHostX(right.x);
      plateCssW = plateRight - plateLeft;
    }
    const hostW = hostRect.width;
    const out = {
      hostW,
      hostH: hostRect.height,
      innerW: window.innerWidth || 0,
      plateCssW,
      plateLeft,
      plateRight,
      gapL: plateLeft == null ? null : plateLeft,
      gapR: plateRight == null ? null : hostW - plateRight,
      ratio: plateCssW == null || !hostW ? null : plateCssW / hostW,
      homeDist,
      camDist: camDist(),
      homeFill: HOME_FILL,
      plane: MOVIE.plane,
      cameraFov: camera?.fov,
      bufferW,
      bufferH,
      panMarginPx,
      width,
      height,
    };
    if (typeof document !== "undefined") {
      document.documentElement.dataset.sunLayout = JSON.stringify(out);
    }
    return out;
  }

  return {
    resize,
    fitToHost,
    resetView,
    setObserver,
    setTime,
    setCyclePhase,
    setOrbiting,
    isOrbiting,
    isParkedFramePainted,
    isFramePainted,
    getMovieWindow,
    moviePhase01FromDate,
    dateFromMoviePhase01,
    setOrbitFaceSec(sec) {
      const n = Number(sec);
      if (!Number.isFinite(n)) return orbitFaceSec;
      orbitFaceSec = THREE.MathUtils.clamp(n, 8, 400);
      return orbitFaceSec;
    },
    getOrbitFaceSec: () => orbitFaceSec,
    getPhaseInfo,
    getObserver,
    setFlameParams,
    getFlameParams,
    getLayoutMetrics,
    getFrameLoadStats,
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
      frameImgs = [];
      if (plateTex) {
        plateTex.dispose();
        plateTex = null;
      }
      plateCanvas = null;
      plateCtx = null;
      if (mesh) {
        mesh.geometry.dispose();
        material?.uniforms?.uMap?.value?.dispose?.();
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
