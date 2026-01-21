import { useEffect, useRef, useState } from "react";

type Light = { angle: number; elev: number };

function readFileAsDataURL(file: File): Promise<string> { //read files into decodable urls
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function App() {
  const [fgSrc, setFgSrc] = useState<string | null>(null);
  const [bgSrc, setBgSrc] = useState<string | null>(null);
  const [depthSrc, setDepthSrc] = useState<string | null>(null);
  
  const canvasRef = useRef<HTMLCanvasElement | null>(null); //reference for composite canvas DOM element
  const maskRef = useRef<HTMLCanvasElement | null>(null); //reference for mask canvas DOM element
  const shadowRef = useRef<HTMLCanvasElement | null>(null); //reference for shadow canvas DOM element
  const depthCanvasRef = useRef<HTMLCanvasElement | null>(null); //reference for depth canvas DOM element
  
  const [light, setLight] = useState<Light>({ angle: 180, elev: 55 }); //default starting light parameters so shadow can be visible on image load
  const [maskVersion, setMaskVersion] = useState(0);

  const [shadowVersion, setShadowVersion] = useState(0);
  const [fgPlacement, setFgPlacement] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);

  const [depthBuf, setDepthBuf] = useState<Float32Array | null>(null);
  const [depthW, setDepthW] = useState(0);
  const [depthH, setDepthH] = useState(0);
  //const [depthVersion, setDepthVersion] = useState(0);
  
  
  //file imports
  async function onPickFg(file: File | null) {
    if (!file) { setFgSrc(null); setFgPlacement(null); return; }
    setFgPlacement(null);
    setFgSrc(await readFileAsDataURL(file));
  }

  async function onPickBg(file: File | null) {
    if (!file) { setBgSrc(null); setFgPlacement(null); return; }
    setFgPlacement(null);
    setBgSrc(await readFileAsDataURL(file));
  }

  async function onPickDepth(file: File | null) {
    if (!file) { setDepthSrc(null); return; }
    setDepthSrc(await readFileAsDataURL(file));
  }


  //file exports
  function makeStamp() {
    const d = new Date();
    // 2026-01-21_13-05-09
    return d.toISOString().replace("T", "_").replaceAll(":", "-").slice(0, 19);
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
  
  // optional: export the original uploaded images (not the rendered canvases)
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

  function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }
  
  //only compute fgPlacement when bg and fg change
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

      // Set composite canvas size from background
      canvas.width = bg.naturalWidth;
      canvas.height = bg.naturalHeight;

      // Compute placement once
      //scale only happens if foreground is bigger than background
      const scale = Math.min(
        1,
        (canvas.width) / fg.naturalWidth,
        (canvas.height) / fg.naturalHeight
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
  
  // Draw composite: BG -> Shadow -> FG
  useEffect(() => {
    if (!bgSrc) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let cancelled = false;

    const bg = new Image();
    bg.onload = () => {
      if(cancelled) return;
      
      if (canvas.width !== bg.naturalWidth || canvas.height !== bg.naturalHeight) {
        canvas.width = bg.naturalWidth;
        canvas.height = bg.naturalHeight;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bg, 0, 0); //draw the background

      const shadowCanvas = shadowRef.current;
      if (
        shadowCanvas &&
        shadowCanvas.width > 0 &&
        shadowCanvas.height > 0
      ) {
        ctx.drawImage(shadowCanvas, 0, 0); //2 draw the shadow
      }

      if (!fgSrc || !fgPlacement) return;
      
      const fg = new Image();
      fg.onload = () => {
        if(cancelled) return;
        const scale = Math.min(
          1,
          (canvas.width) / fg.naturalWidth,
          (canvas.height) / fg.naturalHeight
        );

        const w = Math.round(fg.naturalWidth * scale);
        const h = Math.round(fg.naturalHeight * scale);
        const x = Math.round((canvas.width - w) / 2);
        const y = Math.round(canvas.height - h);

        ctx.drawImage(fg, x, y, w, h); //3 draw the foreground
      };
      fg.src = fgSrc;
    };
    bg.src = bgSrc;
    return () => {
      cancelled = true;
    };  
  }, [bgSrc, fgSrc, fgPlacement, shadowVersion]);

  // Build mask from FG alpha
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

    const offCtx = off.getContext("2d");
    if (!offCtx) return;

    const fg = new Image();
    fg.onload = () => {
      offCtx.clearRect(0, 0, off.width, off.height);
      offCtx.drawImage(fg, 0, 0, off.width, off.height);

      const imgData = offCtx.getImageData(0, 0, off.width, off.height);
      const d = imgData.data;

      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        d[i + 0] = 255; //make every channel white except the alpha channel which is 4th channel
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

  // Draw shadow from mask onto shadowCanvas
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

    // 0° = light from right, 90° = light from above
    const rad = (light.angle * Math.PI) / 180;

    // Shadow direction is opposite the light direction
    const dirX = -Math.cos(rad);
    const dirY = Math.sin(rad);

    // longer shadows when elevation is low
    const elevClamped = Math.max(1, Math.min(89, light.elev));
    const elevRad = (elevClamped * Math.PI) / 180;
    const k = 1 / Math.tan(elevRad);

    const squash = 0.7;
    const perpX = -dirY;
    const perpY = dirX;

    // This is the mapped direction of the silhouette's local +y axis (after projection).
    // (In practice we draw the silhouette with negative y upwards, so this creates a proper cast.)
    const c = -k * dirX + squash * perpX;
    const d = -k * dirY + squash * perpY;

    sctx.save();

    // Anchor at bottom-center of subject
    sctx.translate(fgPlacement.x + w / 2, fgPlacement.y + h);

    // Apply projection: keep local x as-is, project local y into (c,d)
    // transform(a, b, c, d, e, f):
    //   X = a*x + c*y + e
    //   Y = b*x + d*y + f
    // Here: a=1, b=0 (no "orbit", no rotation of the original x axis)
    sctx.transform(1, 0, c, d, 0, 0);

    //blurred layer underneath
    const invTan = 1 / Math.tan(elevRad);
    const blurPx = Math.round(6 * Math.max(0.7, Math.min(2.0, invTan)));

    sctx.filter = `blur(${blurPx}px)`;
    sctx.globalAlpha = 0.45;

    sctx.globalCompositeOperation = "source-over";
    sctx.drawImage(maskCanvas, -w / 2, -h, w, h);
    sctx.globalCompositeOperation = "source-in";
    sctx.fillStyle = "black";
    sctx.fillRect(-w / 2, -h, w, h);

    //sharp layer above it
    sctx.filter = "none";
    sctx.globalAlpha = 0.90;

    sctx.globalCompositeOperation = "source-over";
    sctx.drawImage(maskCanvas, -w / 2, -h, w, h);
    sctx.globalCompositeOperation = "source-in";
    sctx.fillStyle = "black";
    sctx.fillRect(-w / 2, -h, w, h);

    //fade layers together
    sctx.filter = "none";
    sctx.globalAlpha = 1;
    sctx.globalCompositeOperation = "destination-in";

    const fade = sctx.createLinearGradient(0, -h, 0, 0);
    fade.addColorStop(0.0, "rgba(0,0,0,0.0)");
    fade.addColorStop(0.6, "rgba(0,0,0,0.6)");
    fade.addColorStop(1.0, "rgba(0,0,0,1.0)");

    sctx.fillStyle = fade;
    sctx.fillRect(-w / 2, -h, w, h);

    // reset
    sctx.globalCompositeOperation = "source-over";
    sctx.globalAlpha = 1;
    sctx.filter = "none";

    sctx.restore();
    setShadowVersion((v) => v + 1);
  }, [bgSrc, fgSrc, fgPlacement, light, maskVersion]);

  useEffect(() => {
    let cancelled = false;
    async function buildDepth() {
      if(!depthSrc || !fgPlacement) {
        setDepthBuf(null);
        setDepthW(0);
        setDepthH(0);
        setDepthVersion((v) => v + 1);
        return;
      }
      const w = Math.max(1, Math.round(fgPlacement.w));
      const h = Math.max(1, Math.round(fgPlacement.h));
  
      //sample pixels in canvas
      let c = depthCanvasRef.current;
      if(!c){
        c = document.createElement("canvas");
        depthCanvasRef.current = c;      
      }
      c.width = w;
      c.height = h;
  
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
  
      // Load depth image and draw it scaled to match fgPlacement size
      const img = await loadImage(depthSrc);
      if (cancelled) return;
  
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
  
      const id = ctx.getImageData(0, 0, w, h);
      const data = id.data;
  
      const buf = new Float32Array(w * h);
  
      // Convert RGB -> depth in [0..1]
      // Assumption: bright = closer (bigger depth value)
      // We'll store depth01 = brightness (0..1).
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        // average brightness
        const brightness = (r + g + b) / (3 * 255);
        buf[p] = brightness; // 0..1
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
  }, [depthSrc, fgPlacement]);

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
          Depth loaded: {depthSrc ? "yes" : "no"} • Buffer:{" "}
          {depthBuf ? `${depthW}x${depthH}` : "none"}
        </div>

      </div>

      {/* light controls */}
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
      </div>

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
      
        <button
          onClick={onExportMask}
          disabled={!fgSrc || !fgPlacement}
        >
          Export Mask (PNG)
        </button>
      
        {/* optional originals */}
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

      {/* mask + shadow previews */}
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
      </div>
    </div>
  );
}
