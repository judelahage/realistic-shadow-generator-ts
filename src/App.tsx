import { useEffect, useRef, useState } from "react";

type Light = { angle: number; elev: number };

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Safe for future cases where images might not be data URLs
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

type DepthLayer = { canvas: HTMLCanvasElement; zMid: number };

export default function App() {
  const [fgSrc, setFgSrc] = useState<string | null>(null);
  const [bgSrc, setBgSrc] = useState<string | null>(null);
  const [depthSrc, setDepthSrc] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const shadowRef = useRef<HTMLCanvasElement | null>(null);
  const depthCanvasRef = useRef<HTMLCanvasElement | null>(null); // offscreen depth sampling

  // Depth preview canvases (new)
  const depthPreviewRef = useRef<HTMLCanvasElement | null>(null);
  const depthMaskedPreviewRef = useRef<HTMLCanvasElement | null>(null);

  const [light, setLight] = useState<Light>({ angle: 180, elev: 55 });
  const [maskVersion, setMaskVersion] = useState(0);
  const [shadowVersion, setShadowVersion] = useState(0);

  const [fgPlacement, setFgPlacement] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  // Depth buffer
  const [depthBuf, setDepthBuf] = useState<Float32Array | null>(null);
  const [depthW, setDepthW] = useState(0);
  const [depthH, setDepthH] = useState(0);
  const [depthVersion, setDepthVersion] = useState(0);

  // Prebuilt depth slices (so we don't rebuild per light change)
  const depthLayersRef = useRef<DepthLayer[]>([]);
  const [depthLayersVersion, setDepthLayersVersion] = useState(0);

  // Controls
  const [depthStrength, setDepthStrength] = useState(0.8);

  // Depth calibration
  const [invertDepth, setInvertDepth] = useState(false);
  const [depthGamma, setDepthGamma] = useState(1.0); // 0.4..2.5 typical
  const [layerCount, setLayerCount] = useState(16); // 8..32 typical

  // Depth alignment (new)
  // offset in pixels in the depth-sampling canvas space (same size as fgPlacement w/h)
  const [depthOffsetX, setDepthOffsetX] = useState(0);
  const [depthOffsetY, setDepthOffsetY] = useState(0);
  // scale multiplier around center (1 = no scale)
  const [depthScale, setDepthScale] = useState(1);

  // Optional: hide/show previews (new)
  const [showDepthPreview, setShowDepthPreview] = useState(true);

  // -----------------------------
  // File imports
  // -----------------------------
  async function onPickFg(file: File | null) {
    if (!file) {
      setFgSrc(null);
      setFgPlacement(null);
      return;
    }
    setFgPlacement(null);
    setFgSrc(await readFileAsDataURL(file));
  }

  async function onPickBg(file: File | null) {
    if (!file) {
      setBgSrc(null);
      setFgPlacement(null);
      return;
    }
    setFgPlacement(null);
    setBgSrc(await readFileAsDataURL(file));
  }

  async function onPickDepth(file: File | null) {
    if (!file) {
      setDepthSrc(null);
      return;
    }
    setDepthSrc(await readFileAsDataURL(file));
  }

  // -----------------------------
  // File exports
  // -----------------------------
  function makeStamp() {
    const d = new Date();
    return d.toISOString().replace("T", "_").replace(/:/g, "-").slice(0, 19);
  }

  async function onExportComposite() {
    await exportCanvas(canvasRef.current, `composite_${makeStamp()}.png`);
  }

  async function onExportShadow() {
    await exportCanvas(shadowRef.current, `shadow_${makeStamp()}.png`);
  }

  async function onExportMask() {
    await exportCanvas(maskRef.current, `mask_${makeStamp()}.png`);
  }

  async function onExportForegroundOriginal() {
    await exportDataUrl(fgSrc, `foreground_original_${makeStamp()}.png`);
  }

  async function onExportBackgroundOriginal() {
    await exportDataUrl(bgSrc, `background_original_${makeStamp()}.png`);
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function canvasToBlob(
    canvas: HTMLCanvasElement,
    mime: string = "image/png",
    quality?: number
  ): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("canvas.toBlob() failed"))),
        mime,
        quality
      );
    });
  }

  async function exportCanvas(
    canvas: HTMLCanvasElement | null,
    filename: string,
    mime: string = "image/png",
    quality?: number
  ) {
    if (!canvas) return;
    const blob = await canvasToBlob(canvas, mime, quality);
    downloadBlob(blob, filename);
  }

  async function exportDataUrl(dataUrl: string | null, filename: string) {
    if (!dataUrl) return;
    const blob = await (await fetch(dataUrl)).blob();
    downloadBlob(blob, filename);
  }

  // -----------------------------
  // Compute fgPlacement (once bg+fg are loaded)
  // -----------------------------
  useEffect(() => {
    if (!bgSrc || !fgSrc) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;

    const bg = new Image();
    const fg = new Image();

    const tryCompute = () => {
      if (cancelled) return;
      if (!bg.complete || !fg.complete) return;
      if (bg.naturalWidth === 0 || fg.naturalWidth === 0) return;

      canvas.width = bg.naturalWidth;
      canvas.height = bg.naturalHeight;

      const scale = Math.min(
        1,
        canvas.width / fg.naturalWidth,
        canvas.height / fg.naturalHeight
      );

      const w = Math.round(scale * fg.naturalWidth);
      const h = Math.round(scale * fg.naturalHeight);
      const x = Math.round((canvas.width - w) / 2);
      const y = Math.round(canvas.height - h);

      setFgPlacement({ x, y, w, h });
    };

    bg.onload = tryCompute;
    fg.onload = tryCompute;
    bg.src = bgSrc;
    fg.src = fgSrc;

    return () => {
      cancelled = true;
    };
  }, [bgSrc, fgSrc]);

  // -----------------------------
  // Draw composite: BG -> Shadow -> FG
  // -----------------------------
  useEffect(() => {
    if (!bgSrc) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let cancelled = false;

    const bg = new Image();
    bg.onload = () => {
      if (cancelled) return;

      if (
        canvas.width !== bg.naturalWidth ||
        canvas.height !== bg.naturalHeight
      ) {
        canvas.width = bg.naturalWidth;
        canvas.height = bg.naturalHeight;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bg, 0, 0);

      const shadowCanvas = shadowRef.current;
      if (shadowCanvas && shadowCanvas.width > 0 && shadowCanvas.height > 0) {
        ctx.drawImage(shadowCanvas, 0, 0);
      }

      if (!fgSrc || !fgPlacement) return;

      const fg = new Image();
      fg.onload = () => {
        if (cancelled) return;
        ctx.drawImage(
          fg,
          fgPlacement.x,
          fgPlacement.y,
          fgPlacement.w,
          fgPlacement.h
        );
      };
      fg.src = fgSrc;
    };

    bg.src = bgSrc;

    return () => {
      cancelled = true;
    };
  }, [bgSrc, fgSrc, fgPlacement, shadowVersion]);

  // -----------------------------
  // Build mask from FG alpha
  // -----------------------------
  useEffect(() => {
    if (!fgSrc) return;
    if (!fgPlacement) return;

    const maskCanvas = maskRef.current;
    if (!maskCanvas) return;

    const ctx = maskCanvas.getContext("2d");
    if (!ctx) return;

    const off = document.createElement("canvas");
    off.width = fgPlacement.w;
    off.height = fgPlacement.h;

    const offCtx = off.getContext("2d", { willReadFrequently: true });
    if (!offCtx) return;

    const fg = new Image();
    fg.onload = () => {
      offCtx.clearRect(0, 0, off.width, off.height);
      offCtx.drawImage(fg, 0, 0, off.width, off.height);

      const imgData = offCtx.getImageData(0, 0, off.width, off.height);
      const d = imgData.data;

      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        d[i + 0] = 255;
        d[i + 1] = 255;
        d[i + 2] = 255;
        d[i + 3] = a;
      }

      maskCanvas.width = off.width;
      maskCanvas.height = off.height;
      ctx.putImageData(imgData, 0, 0);
      setMaskVersion((v) => v + 1);
    };

    fg.src = fgSrc;
  }, [fgSrc, fgPlacement]);

  // -----------------------------
  // Build depth buffer from depthSrc (with invert/gamma + alignment)
  // -----------------------------
  useEffect(() => {
    let cancelled = false;

    async function buildDepth() {
      if (!depthSrc || !fgPlacement) {
        setDepthBuf(null);
        setDepthW(0);
        setDepthH(0);
        setDepthVersion((v) => v + 1);
        return;
      }

      const w = Math.max(1, Math.round(fgPlacement.w));
      const h = Math.max(1, Math.round(fgPlacement.h));

      let c = depthCanvasRef.current;
      if (!c) {
        c = document.createElement("canvas");
        depthCanvasRef.current = c;
      }
      c.width = w;
      c.height = h;

      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;

      const img = await loadImage(depthSrc);
      if (cancelled) return;

      // Draw depth image into the sampling canvas, with center-scale + offsets.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const s = Math.max(0.1, Math.min(4, depthScale));
      const dx = depthOffsetX;
      const dy = depthOffsetY;

      // baseline draw is "fill the same w/h"
      const dw = w * s;
      const dh = h * s;
      const x = (w - dw) / 2 + dx;
      const y = (h - dh) / 2 + dy;

      ctx.drawImage(img, x, y, dw, dh);

      const id = ctx.getImageData(0, 0, w, h);
      const data = id.data;

      const buf = new Float32Array(w * h);

      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];

        let z = (r + g + b) / (3 * 255); // 0..1
        if (invertDepth) z = 1 - z;

        // gamma: <1 boosts highlights, >1 boosts shadows
        z = Math.pow(clamp01(z), depthGamma);

        buf[p] = z;
      }

      if (cancelled) return;

      setDepthBuf(buf);
      setDepthW(w);
      setDepthH(h);
      setDepthVersion((v) => v + 1);
    }

    buildDepth();

    return () => {
      cancelled = true;
    };
  }, [
    depthSrc,
    fgPlacement,
    invertDepth,
    depthGamma,
    depthScale,
    depthOffsetX,
    depthOffsetY,
  ]);

  // -----------------------------
  // Depth preview render (new): processed depth + masked depth
  // -----------------------------
  useEffect(() => {
    const c1 = depthPreviewRef.current;
    const c2 = depthMaskedPreviewRef.current;

    // If previews are hidden, keep canvases minimal (but still valid)
    if (!showDepthPreview) {
      if (c1) {
        c1.width = 1;
        c1.height = 1;
        const x = c1.getContext("2d");
        x?.clearRect(0, 0, 1, 1);
      }
      if (c2) {
        c2.width = 1;
        c2.height = 1;
        const x = c2.getContext("2d");
        x?.clearRect(0, 0, 1, 1);
      }
      return;
    }

    if (!depthBuf || depthW <= 0 || depthH <= 0) {
      if (c1) {
        c1.width = 1;
        c1.height = 1;
        const x = c1.getContext("2d");
        x?.clearRect(0, 0, 1, 1);
      }
      if (c2) {
        c2.width = 1;
        c2.height = 1;
        const x = c2.getContext("2d");
        x?.clearRect(0, 0, 1, 1);
      }
      return;
    }

    const w = depthW;
    const h = depthH;

    // Build grayscale image (opaque)
    const img = new ImageData(w, h);
    const id = img.data;

    for (let p = 0; p < w * h; p++) {
      const v = Math.round(clamp01(depthBuf[p]) * 255);
      const o = p * 4;
      id[o + 0] = v;
      id[o + 1] = v;
      id[o + 2] = v;
      id[o + 3] = 255;
    }

    if (c1) {
      if (c1.width !== w) c1.width = w;
      if (c1.height !== h) c1.height = h;
      const ctx = c1.getContext("2d", { willReadFrequently: true });
      ctx?.putImageData(img, 0, 0);
    }

    // Build masked grayscale image (alpha from mask)
    if (c2) {
      if (c2.width !== w) c2.width = w;
      if (c2.height !== h) c2.height = h;

      const out = new ImageData(w, h);
      const od = out.data;

      let maskAlpha: Uint8ClampedArray | null = null;
      const maskCanvas = maskRef.current;
      if (maskCanvas && maskCanvas.width === w && maskCanvas.height === h) {
        const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });
        if (mctx) {
          const mid = mctx.getImageData(0, 0, w, h).data;
          maskAlpha = new Uint8ClampedArray(w * h);
          for (let p = 0; p < w * h; p++) {
            maskAlpha[p] = mid[p * 4 + 3];
          }
        }
      }

      for (let p = 0; p < w * h; p++) {
        const v = Math.round(clamp01(depthBuf[p]) * 255);
        const a = maskAlpha ? maskAlpha[p] : 255;
        const o = p * 4;
        od[o + 0] = v;
        od[o + 1] = v;
        od[o + 2] = v;
        od[o + 3] = a; // transparent outside subject
      }

      const ctx2 = c2.getContext("2d", { willReadFrequently: true });
      ctx2?.putImageData(out, 0, 0);
    }
  }, [showDepthPreview, depthBuf, depthW, depthH, maskVersion]);

  // -----------------------------
  // Pre-slice mask into depth layers (rebuild only when mask/depth changes)
  // -----------------------------
  useEffect(() => {
    const maskCanvas = maskRef.current;

    if (!maskCanvas || !fgPlacement || !depthBuf) {
      depthLayersRef.current = [];
      setDepthLayersVersion((v) => v + 1);
      return;
    }

    const w = fgPlacement.w;
    const h = fgPlacement.h;

    if (maskCanvas.width !== w || maskCanvas.height !== h) {
      depthLayersRef.current = [];
      setDepthLayersVersion((v) => v + 1);
      return;
    }

    if (depthW !== w || depthH !== h) {
      depthLayersRef.current = [];
      setDepthLayersVersion((v) => v + 1);
      return;
    }

    const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });
    if (!mctx) {
      depthLayersRef.current = [];
      setDepthLayersVersion((v) => v + 1);
      return;
    }

    const maskId = mctx.getImageData(0, 0, w, h);
    const maskData = maskId.data;

    const layerCountLocal = Math.max(1, Math.round(layerCount));
    const layers: DepthLayer[] = [];

    for (let li = 0; li < layerCountLocal; li++) {
      const z0 = li / layerCountLocal;
      const z1 = (li + 1) / layerCountLocal;
      const zMid = (z0 + z1) * 0.5;

      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;

      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) continue;

      const out = new ImageData(w, h);
      const outData = out.data;

      for (let p = 0; p < w * h; p++) {
        const a = maskData[p * 4 + 3];
        if (a === 0) continue;

        const z = depthBuf[p];
        const inRange =
          li === layerCountLocal - 1 ? z >= z0 && z <= 1 : z >= z0 && z < z1;
        if (!inRange) continue;

        // store as black with alpha
        outData[p * 4 + 0] = 0;
        outData[p * 4 + 1] = 0;
        outData[p * 4 + 2] = 0;
        outData[p * 4 + 3] = a;
      }

      ctx.putImageData(out, 0, 0);
      layers.push({ canvas: c, zMid });
    }

    depthLayersRef.current = layers;
    setDepthLayersVersion((v) => v + 1);
  }, [fgPlacement, maskVersion, depthVersion, depthBuf, depthW, depthH, layerCount]);

  // -----------------------------
  // Draw shadow (depth-aware when depth layers exist)
  // -----------------------------
  useEffect(() => {
    if (!bgSrc) return;
    if (!fgSrc) return;
    if (!fgPlacement) return;

    const baseCanvas = canvasRef.current;
    const shadowCanvas = shadowRef.current;
    const maskCanvas = maskRef.current;
    if (!baseCanvas || !shadowCanvas || !maskCanvas) return;
    if (maskCanvas.width === 0 || maskCanvas.height === 0) return;

    const sctx = shadowCanvas.getContext("2d");
    if (!sctx) return;

    shadowCanvas.width = baseCanvas.width;
    shadowCanvas.height = baseCanvas.height;

    sctx.clearRect(0, 0, shadowCanvas.width, shadowCanvas.height);
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalAlpha = 1;
    sctx.filter = "none";
    sctx.globalCompositeOperation = "source-over";

    const w = fgPlacement.w;
    const h = fgPlacement.h;

    const rad = (light.angle * Math.PI) / 180;
    const dirX = -Math.cos(rad);
    const dirY = Math.sin(rad);

    const elevClamped = Math.max(1, Math.min(89, light.elev));
    const elevRad = (elevClamped * Math.PI) / 180;
    const kBase = 1 / Math.tan(elevRad);

    const squash = 0.7;
    const perpX = -dirY;
    const perpY = dirX;

    // Anchor at bottom-center of subject
    const ax = fgPlacement.x + w / 2;
    const ay = fgPlacement.y + h;

    const layers = depthLayersRef.current;

    // Fallback: no depth layers -> old single-mask method
    if (!layers || layers.length === 0) {
      const c = -kBase * dirX + squash * perpX;
      const d = -kBase * dirY + squash * perpY;

      sctx.save();
      sctx.translate(ax, ay);
      sctx.transform(1, 0, c, d, 0, 0);

      const invTan = 1 / Math.tan(elevRad);
      const blurPx = Math.round(6 * Math.max(0.7, Math.min(2.0, invTan)));

      // blurred layer
      sctx.filter = `blur(${blurPx}px)`;
      sctx.globalAlpha = 0.45;
      sctx.globalCompositeOperation = "source-over";
      sctx.drawImage(maskCanvas, -w / 2, -h, w, h);
      sctx.globalCompositeOperation = "source-in";
      sctx.fillStyle = "black";
      sctx.fillRect(-w / 2, -h, w, h);

      // sharp layer
      sctx.filter = "none";
      sctx.globalAlpha = 0.9;
      sctx.globalCompositeOperation = "source-over";
      sctx.drawImage(maskCanvas, -w / 2, -h, w, h);
      sctx.globalCompositeOperation = "source-in";
      sctx.fillStyle = "black";
      sctx.fillRect(-w / 2, -h, w, h);

      // fade (vertical in local space)
      sctx.filter = "none";
      sctx.globalAlpha = 1;
      sctx.globalCompositeOperation = "destination-in";

      const fade = sctx.createLinearGradient(0, -h, 0, 0);
      fade.addColorStop(0.0, "rgba(0,0,0,0.0)");
      fade.addColorStop(0.6, "rgba(0,0,0,0.6)");
      fade.addColorStop(1.0, "rgba(0,0,0,1.0)");

      sctx.fillStyle = fade;
      sctx.fillRect(-w / 2, -h, w, h);

      sctx.globalCompositeOperation = "source-over";
      sctx.globalAlpha = 1;
      sctx.filter = "none";
      sctx.restore();

      setShadowVersion((v) => v + 1);
      return;
    }

    // Depth-aware draw
    const invTan = 1 / Math.tan(elevRad);
    const baseBlur = Math.round(6 * Math.max(0.7, Math.min(2.0, invTan)));

    for (const layer of layers) {
      const z = clamp01(layer.zMid);

      // cast length varies by depth
      const kLayer = kBase * (1 + depthStrength * z);

      const cL = -kLayer * dirX + squash * perpX;
      const dL = -kLayer * dirY + squash * perpY;

      // deeper -> blurrier + lighter
      const blurMult = lerp(0.7, 1.8, z);
      const blurPx = Math.round(baseBlur * blurMult);

      const sharpAlpha = lerp(0.85, 0.25, z);
      const blurAlpha = lerp(0.06, 0.2, z);

      sctx.save();
      sctx.translate(ax, ay);
      sctx.transform(1, 0, cL, dL, 0, 0);
      sctx.globalCompositeOperation = "source-over";

      // blurred
      sctx.filter = `blur(${blurPx}px)`;
      sctx.globalAlpha = blurAlpha;
      sctx.drawImage(layer.canvas, -w / 2, -h, w, h);

      // sharp
      sctx.filter = "none";
      sctx.globalAlpha = sharpAlpha;
      sctx.drawImage(layer.canvas, -w / 2, -h, w, h);

      sctx.restore();
    }

    // Fade the whole shadow along cast direction in screen space
    sctx.save();
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalCompositeOperation = "destination-in";
    sctx.filter = "none";
    sctx.globalAlpha = 1;

    const maxLen = Math.max(
      10,
      h * kBase * (1 + Math.max(0, depthStrength)) * 0.9
    );
    const gx0 = ax;
    const gy0 = ay;
    const gx1 = ax + dirX * maxLen;
    const gy1 = ay + dirY * maxLen;

    const g = sctx.createLinearGradient(gx0, gy0, gx1, gy1);
    g.addColorStop(0.0, "rgba(0,0,0,1.0)");
    g.addColorStop(0.75, "rgba(0,0,0,0.55)");
    g.addColorStop(1.0, "rgba(0,0,0,0.0)");

    sctx.fillStyle = g;
    sctx.fillRect(0, 0, shadowCanvas.width, shadowCanvas.height);

    sctx.restore();

    setShadowVersion((v) => v + 1);
  }, [
    bgSrc,
    fgSrc,
    fgPlacement,
    light,
    maskVersion,
    depthVersion,
    depthLayersVersion,
    depthStrength,
  ]);

  const depthReady = !!depthBuf && depthW > 0 && depthH > 0;

  return (
    <div
      style={{
        padding: 20,
        fontFamily: "Figtree",
        boxSizing: "border-box",
        maxWidth: 1400,
        margin: "0 auto",
      }}
    >
      <h1 style={{ marginTop: 0 }}>Realistic Shadow Generator</h1>

      {/* Upload controls */}
      <div
        style={{
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          alignItems: "end",
        }}
      >
        <label style={{ display: "grid", gap: 6 }}>
          Upload Foreground (PNG cutout preferred)
          <input
            type="file"
            accept="image/*"
            onChange={(e) => onPickFg(e.target.files?.[0] ?? null)}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          Upload Background
          <input
            type="file"
            accept="image/*"
            onChange={(e) => onPickBg(e.target.files?.[0] ?? null)}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          Upload Depth Map (aligned to foreground)
          <input
            type="file"
            accept="image/*"
            onChange={(e) => onPickDepth(e.target.files?.[0] ?? null)}
          />
        </label>

        <div style={{ opacity: 0.8, fontSize: 12, marginTop: 6 }}>
          Depth loaded: {depthSrc ? "yes" : "no"} | Buffer:{" "}
          {depthReady ? `${depthW}x${depthH}` : "none"} | Depth v: {depthVersion}
        </div>
      </div>

      {/* Controls */}
      <div
        style={{
          marginTop: 14,
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          alignItems: "end",
        }}
      >
        <label
          style={{
            display: "grid",
            gap: 6,
            minWidth: 260,
            flex: "1 1 260px",
          }}
        >
          Light angle: {light.angle}°
          <input
            type="range"
            min={0}
            max={360}
            value={light.angle}
            onChange={(e) =>
              setLight((s) => ({ ...s, angle: Number(e.target.value) }))
            }
          />
        </label>

        <label
          style={{
            display: "grid",
            gap: 6,
            minWidth: 260,
            flex: "1 1 260px",
          }}
        >
          Light elevation: {light.elev}°
          <input
            type="range"
            min={1}
            max={89}
            value={light.elev}
            onChange={(e) =>
              setLight((s) => ({ ...s, elev: Number(e.target.value) }))
            }
          />
        </label>

        <label
          style={{
            display: "grid",
            gap: 6,
            minWidth: 260,
            flex: "1 1 260px",
          }}
        >
          Depth strength: {depthStrength.toFixed(2)}
          <input
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={depthStrength}
            onChange={(e) => setDepthStrength(Number(e.target.value))}
            disabled={!depthReady}
          />
        </label>

        <label
          style={{
            display: "grid",
            gap: 6,
            minWidth: 180,
            flex: "0 1 180px",
          }}
        >
          Invert depth
          <input
            type="checkbox"
            checked={invertDepth}
            onChange={(e) => setInvertDepth(e.target.checked)}
            disabled={!depthReady}
          />
        </label>

        <label
          style={{
            display: "grid",
            gap: 6,
            minWidth: 260,
            flex: "1 1 260px",
          }}
        >
          Depth gamma: {depthGamma.toFixed(2)}
          <input
            type="range"
            min={0.4}
            max={2.5}
            step={0.01}
            value={depthGamma}
            onChange={(e) => setDepthGamma(Number(e.target.value))}
            disabled={!depthReady}
          />
        </label>

        <label
          style={{
            display: "grid",
            gap: 6,
            minWidth: 260,
            flex: "1 1 260px",
          }}
        >
          Depth layers: {layerCount}
          <input
            type="range"
            min={8}
            max={32}
            step={1}
            value={layerCount}
            onChange={(e) => setLayerCount(Number(e.target.value))}
            disabled={!depthReady}
          />
        </label>
      </div>

      {/* Depth alignment (new) */}
      <div
        style={{
          marginTop: 10,
          display: "flex",
          gap: 16,
          flexWrap: "wrap",
          alignItems: "end",
        }}
      >
        <label
          style={{
            display: "grid",
            gap: 6,
            minWidth: 260,
            flex: "1 1 260px",
          }}
        >
          Depth scale: {depthScale.toFixed(2)}
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.01}
            value={depthScale}
            onChange={(e) => setDepthScale(Number(e.target.value))}
            disabled={!depthSrc}
          />
        </label>

        <label
          style={{
            display: "grid",
            gap: 6,
            minWidth: 260,
            flex: "1 1 260px",
          }}
        >
          Depth offset X: {depthOffsetX}px
          <input
            type="range"
            min={-300}
            max={300}
            step={1}
            value={depthOffsetX}
            onChange={(e) => setDepthOffsetX(Number(e.target.value))}
            disabled={!depthSrc}
          />
        </label>

        <label
          style={{
            display: "grid",
            gap: 6,
            minWidth: 260,
            flex: "1 1 260px",
          }}
        >
          Depth offset Y: {depthOffsetY}px
          <input
            type="range"
            min={-300}
            max={300}
            step={1}
            value={depthOffsetY}
            onChange={(e) => setDepthOffsetY(Number(e.target.value))}
            disabled={!depthSrc}
          />
        </label>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={() => {
              setDepthScale(1);
              setDepthOffsetX(0);
              setDepthOffsetY(0);
            }}
            disabled={!depthSrc}
          >
            Reset Depth Align
          </button>

          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={showDepthPreview}
              onChange={(e) => setShowDepthPreview(e.target.checked)}
              disabled={!depthReady}
            />
            Show depth preview
          </label>
        </div>
      </div>

      {/* Export buttons */}
      <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button
          onClick={onExportComposite}
          disabled={!bgSrc || !fgSrc || !fgPlacement}
        >
          Export Composite (PNG)
        </button>

        <button
          onClick={onExportShadow}
          disabled={!bgSrc || !fgSrc || !fgPlacement}
        >
          Export Shadow (PNG)
        </button>

        <button onClick={onExportMask} disabled={!fgSrc || !fgPlacement}>
          Export Mask (PNG)
        </button>

        <button onClick={onExportForegroundOriginal} disabled={!fgSrc}>
          Export FG Original
        </button>
        <button onClick={onExportBackgroundOriginal} disabled={!bgSrc}>
          Export BG Original
        </button>
      </div>

      {/* Previews */}
      <div
        style={{
          marginTop: 18,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 20,
          alignItems: "start",
        }}
      >
        {/* Foreground */}
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: "8px 0" }}>Foreground preview</h3>
          <div
            style={{
              width: "100%",
              maxWidth: 520,
              aspectRatio: "1 / 1",
              backgroundColor: "rgba(0,0,0,0.35)",
              borderRadius: 10,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.12)",
              boxSizing: "border-box",
            }}
          >
            {fgSrc ? (
              <img
                src={fgSrc}
                alt="Foreground preview"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  display: "block",
                }}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "grid",
                  placeItems: "center",
                  opacity: 0.75,
                  padding: 16,
                  textAlign: "center",
                }}
              />
            )}
          </div>
        </div>

        {/* Background */}
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: "8px 0" }}>Background preview</h3>
          <div
            style={{
              width: "100%",
              maxWidth: 520,
              aspectRatio: "1 / 1",
              backgroundColor: "rgba(0,0,0,0.35)",
              borderRadius: 10,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.12)",
              boxSizing: "border-box",
            }}
          >
            {bgSrc ? (
              <img
                src={bgSrc}
                alt="Background preview"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  display: "block",
                }}
              />
            ) : (
              <div
                style={{
                  height: "100%",
                  display: "grid",
                  placeItems: "center",
                  opacity: 0.75,
                  padding: 16,
                  textAlign: "center",
                }}
              />
            )}
          </div>
        </div>

        {/* Composite */}
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: "8px 0" }}>Composite Preview</h3>
          <div
            style={{
              width: "100%",
              maxWidth: 520,
              aspectRatio: "1 / 1",
              backgroundColor: "rgba(0,0,0,0.35)",
              borderRadius: 10,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.12)",
              boxSizing: "border-box",
            }}
          >
            <canvas
              ref={canvasRef}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                display: "block",
              }}
            />
          </div>
        </div>
      </div>

      {/* mask + shadow + depth previews */}
      <div
        style={{
          marginTop: 18,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: "8px 0" }}>Mask</h3>
          <div
            style={{
              width: "100%",
              backgroundColor: "rgba(0,0,0,0.35)",
              borderRadius: 10,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.12)",
              boxSizing: "border-box",
            }}
          >
            <canvas
              ref={maskRef}
              style={{
                width: "100%",
                height: 360,
                display: "block",
                backgroundColor: "black",
              }}
            />
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: "8px 0" }}>Shadow</h3>
          <div
            style={{
              width: "100%",
              backgroundColor: "rgba(0,0,0,0.35)",
              borderRadius: 10,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.12)",
              boxSizing: "border-box",
            }}
          >
            <canvas
              ref={shadowRef}
              style={{
                width: "100%",
                height: 360,
                display: "block",
                backgroundColor: "white",
              }}
            />
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: "8px 0" }}>Depth (processed)</h3>
          <div
            style={{
              width: "100%",
              backgroundColor: "rgba(0,0,0,0.35)",
              borderRadius: 10,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.12)",
              boxSizing: "border-box",
            }}
          >
            <canvas
              ref={depthPreviewRef}
              style={{
                width: "100%",
                height: 360,
                display: "block",
                backgroundColor: "black",
              }}
            />
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: "8px 0" }}>Depth (masked by subject)</h3>
          <div
            style={{
              width: "100%",
              backgroundColor: "rgba(0,0,0,0.35)",
              borderRadius: 10,
              overflow: "hidden",
              border: "1px solid rgba(255,255,255,0.12)",
              boxSizing: "border-box",
            }}
          >
            <canvas
              ref={depthMaskedPreviewRef}
              style={{
                width: "100%",
                height: 360,
                display: "block",
                backgroundColor: "black",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
