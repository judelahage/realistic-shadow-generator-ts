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

export default function App() {
  const [fgSrc, setFgSrc] = useState<string | null>(null);
  const [bgSrc, setBgSrc] = useState<string | null>(null);
  const [depthSrc, setDepthSrc] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null); //canvas reference
  const maskRef = useRef<HTMLCanvasElement | null>(null); //mask reference
  const shadowRef = useRef<HTMLCanvasElement | null>(null); //shadow reference
  const [light, setLight] = useState<Light>({ angle: 45, elev: 35 });
  const [fgPlacement, setFgPlacement] = useState<{
    x: number; y: number; w: number; h: number;
  } | null>(null);



  async function onPickFg(file: File | null) {
    if (!file) {
      setFgSrc(null);
      return;
    }
    setFgSrc(await readFileAsDataURL(file));
  }

  async function onPickBg(file: File | null) {
    if (!file) {
      setBgSrc(null);
      return;
    }
    setBgSrc(await readFileAsDataURL(file));
  }

  async function onPickDepth(file: File | null) {
    if (!file) {
      setDepthSrc(null);
      return;
    }
    setDepthSrc(await readFileAsDataURL(file));
  }

  //canvas draw effect
  useEffect(() => {
    //failsafes
    if (!bgSrc) return; 
    const canvas = canvasRef.current; 
    if(!canvas) return; 
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const bg = new Image();
    bg.onload = () => {
      canvas.width = bg.naturalWidth;
      canvas.height = bg.naturalHeight;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bg, 0 ,0);

      const shadowCanvas = shadowRef.current; //pull shadowCanvas reference
      if(shadowCanvas && shadowCanvas.width > 0 && shadowCanvas.height > 0){ //if shadow canvas has something then composite it under the foreground to display the shadow
        ctx.drawImage(shadowCanvas, 0,0);
      }
      
      if (!fgSrc) return;
      const fg = new Image();

      fg.onload = () => {
        const scale = Math.min(
          (canvas.width * 0.6) / fg.naturalWidth,
          (canvas.height * 0.8) / fg.naturalHeight
        );

        //computing width, height, and position for drawing
        const w = Math.round(fg.naturalWidth * scale);

        const h = Math.round(fg.naturalHeight * scale);

        const x = Math.round((canvas.width - w)/2);

        const y = Math.round(canvas.height - h);

        setFgPlacement({x, y, w, h});
        ctx.drawImage(fg, x, y, w, h);
      };

      fg.src = fgSrc;
    };
    bg.src = bgSrc;
  }, [bgSrc, fgSrc, light]);

  //mask draw affect
  useEffect(() => {
    if (!fgSrc) return;
    if (!fgPlacement) return;

    const maskCanvas = maskRef.current;
    if (!maskCanvas) return;

    const ctx = maskCanvas.getContext("2d");
    if (!ctx) return;

    // create an offscreen canvas to draw the FG at the same size as in the composite
    const off = document.createElement("canvas");
    off.width = fgPlacement.w;
    off.height = fgPlacement.h;

    const offCtx = off.getContext("2d");
    if (!offCtx) return;

    const fg = new Image();
    fg.onload = () => {
      // draw foreground into offscreen at the exact composite size
      offCtx.clearRect(0, 0, off.width, off.height); //clear any old pixels
      offCtx.drawImage(fg, 0, 0, off.width, off.height); //draw the foreground image

      // read pixels to get alpha
      const imgData = offCtx.getImageData(0, 0, off.width, off.height);
      const d = imgData.data;

      // convert alpha to grayscale mask
      // white = opaque (subject), black = transparent
      for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3];
        d[i + 0] = a; //setting all color channels to alpha level
        d[i + 1] = a;
        d[i + 2] = a;
        d[i + 3] = 255; //all mask pixels have to be fully opaque so alpha will be set to max
      }

      // show mask at 1:1 pixel size with the drawn FG size
      maskCanvas.width = off.width;
      maskCanvas.height = off.height;

      ctx.putImageData(imgData, 0, 0);
    };

    fg.src = fgSrc;
  }, [fgSrc, fgPlacement]);

//shadow effect
useEffect(() => {
  //failsafes
  if(!bgSrc) return;
  if (!fgSrc) return;
  if (!fgPlacement) return;

  //initializing canvases and their correct size
  const baseCanvas = canvasRef.current;
  const shadowCanvas = shadowRef.current;

  if(!baseCanvas || !shadowCanvas) return;

  const sctx = shadowCanvas.getContext("2d"); //shadow context
  if(!sctx) return;

  shadowCanvas.width = baseCanvas.width;
  shadowCanvas.height = baseCanvas.height;

  sctx.clearRect(0,0, shadowCanvas.width, shadowCanvas.height);

  const fg = new Image();
  fg.onload = () => {
    const dx = Math.round(fgPlacement.w * 0.35); //pushing shadow sideways
    const dy = Math.round(fgPlacement.h * 0.20); //pushing shadow down
    const squashY = 0.35; //make shadow flattened on the gronud
    const shearX = 0.6; //skew to simulate direction

    sctx.save();
    sctx.globalAlpha = 0.45; //making the entire shadow have the same opacity
    sctx.translate(fgPlacement.x + dx, fgPlacement.y + fgPlacement.h + dy); //anchoring the shadow at the object's bottom left corner
    sctx.transform(1, 0, shearX, squashY, 0, 0);
    sctx.drawImage(fg, 0, -fgPlacement.h, fgPlacement.w, fgPlacement.h);
    
    sctx.restore();

  };
  fg.src = fgSrc; //browser loads and decodes the image

}, [bgSrc, fgSrc, fgPlacement]);

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginTop: 0 }}>Realistic Shadow Generator</h1>

      {/* Upload controls */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "end" }}>
        <label style={{ display: "grid", gap: 6 }}>
          Foreground (PNG cutout preferred)
          <input
            type="file"
            accept="image/*"
            onChange={(e) => onPickFg(e.target.files?.[0] ?? null)}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          Background
          <input
            type="file"
            accept="image/*"
            onChange={(e) => onPickBg(e.target.files?.[0] ?? null)}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          Depth map (optional)
          <input
            type="file"
            accept="image/*"
            onChange={(e) => onPickDepth(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>

      {/* light controls (stored only for now) */}
      <div style={{ marginTop: 14, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <label style={{ display: "grid", gap: 6, minWidth: 260 }}>
          Light angle: {light.angle}°
          <input
            type="range"
            min={0}
            max={360}
            value={light.angle}
            onChange={(e) => setLight((s) => ({ ...s, angle: Number(e.target.value) }))}
          />
        </label>

        <label style={{ display: "grid", gap: 6, minWidth: 260 }}>
          Light elevation: {light.elev}°
          <input
            type="range"
            min={0}
            max={90}
            value={light.elev}
            onChange={(e) => setLight((s) => ({ ...s, elev: Number(e.target.value) }))}
          />
        </label>

        <div style={{ alignSelf: "end", opacity: 0.7 }}>
          Depth loaded: {depthSrc ? "yes" : "no"}
        </div>
      </div>

      {/* Previews */}
      <div
        style={{
          marginTop: 18,
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          alignItems: "start",
        }}
      >
        <div>
          <h3 style={{ margin: "8px 0" }}>Background preview</h3>
          {bgSrc ? (
            <img
              src={bgSrc}
              alt="Background preview"
              style={{ width: "100%", border: "1px solid #ccc", display: "block" }}
            />
          ) : (
            <div style={{ border: "1px dashed #999", padding: 16, opacity: 0.7 }}>
              Upload a background image
            </div>
          )}
        </div>

        <div>
          <h3 style={{ margin: "8px 0" }}>Foreground preview</h3>
          {fgSrc ? (
            <img
              src={fgSrc}
              alt="Foreground preview"
              style={{ width: "100%", border: "1px solid #ccc", display: "block" }}
            />
          ) : (
            <div style={{ border: "1px dashed #999", padding: 16, opacity: 0.7 }}>
              Upload a foreground cutout (PNG with transparency is best)
            </div>
          )}
        </div>
      </div>
      
      <div style = {{ marginTop: 18}}>
        <h3 style={{margin:"8px 0"}}>Composite Preview</h3>
        <canvas
          ref={canvasRef}
          style={{width:"100%", border: "1px solid #ccc", display: "block"}}
        />

        <div style = {{marginTop: 6, opacity: 0.7, fontSize: 13}}>
          This canvas is what the shadow and mask are based on.
        </div>
      </div>

      {/* mask preview */}
      <div
        style={{
        marginTop: 18,
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
        alignItems: "start",
        }}
      >
        <div>
          <h3 style={{ margin: "8px 0" }}>mask_debug</h3>
          <canvas
            ref={maskRef}
            style={{ width: "100%", border: "1px solid #ccc", display: "block" }}
          />
          <div style={{ marginTop: 6, opacity: 0.7, fontSize: 13 }}>
            White = subject (alpha), Black = transparent.
          </div>
        </div>

        <div>
          <h3 style={{ margin: "8px 0" }}>shadow_only (next)</h3>
          <canvas
            ref={shadowRef}
            style={{ width: "100%", border: "1px solid #ccc", display: "block" }}
          />
          <div style={{ marginTop: 6, opacity: 0.7, fontSize: 13 }}>
            We’ll project the silhouette here next.
          </div>
        </div>
      </div>

      <p style={{ marginTop: 16, opacity: 0.7 }}>
        Next: draw a composite preview on a canvas, then generate shadow_only + mask_debug.
      </p>
    </div>
  );
}
