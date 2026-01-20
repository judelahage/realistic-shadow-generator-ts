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
  const [maskVersion, setMaskVersion] = useState(0);
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
        d[i + 0] = 255; //setting all pixels to white
        d[i + 1] = 255;
        d[i + 2] = 255;
        d[i + 3] = a; //alpha becomes the silhouette
      }

      // show mask at 1:1 pixel size with the drawn FG size
      maskCanvas.width = off.width;
      maskCanvas.height = off.height;

      ctx.putImageData(imgData, 0, 0);
      setMaskVersion((v) => v + 1);
    };

    fg.src = fgSrc;
  }, [fgSrc, fgPlacement]);


useEffect(() => {
  //failsafes
  if (!bgSrc) return;
  if (!fgSrc) return;
  if (!fgPlacement) return;

  //pull canvases
  const baseCanvas = canvasRef.current;
  const shadowCanvas = shadowRef.current;
  const maskCanvas = maskRef.current;

  if (!baseCanvas || !shadowCanvas || !maskCanvas) return;
  if (maskCanvas.width === 0 || maskCanvas.height === 0) return;

  const sctx = shadowCanvas.getContext("2d");
  if (!sctx) return;

  //shadow canvas matches base canvas size
  shadowCanvas.width = baseCanvas.width;
  shadowCanvas.height = baseCanvas.height;

  //reset drawing state
  sctx.clearRect(0, 0, shadowCanvas.width, shadowCanvas.height);
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.globalAlpha = 1;
  sctx.filter = "none";
  sctx.globalCompositeOperation = "source-over";

  //light direction (in canvas coords: +x right, +y down)
  const rad = (light.angle * Math.PI) / 180;
  const lightX = Math.cos(rad);
  const lightY = -Math.sin(rad);

  //shadow goes opposite the light
  const shadowX = -lightX;
  const shadowY = -lightY;

  //elevation -> longer shadow when elevation is low
  const elevClamped = Math.max(1, Math.min(89, light.elev));
  const elevRad = (elevClamped * Math.PI) / 180;

  //optional tiny bias so shadow isn't glued perfectly at the contact
  const bias = fgPlacement.h * 0.02;
  const dx = Math.round(shadowX * bias);
  const dy = Math.round(shadowY * bias);

  //projection factor
  const k = 1 / Math.tan(elevRad);

  //flattening constant for the debug pass (we’ll tune later)
  const squashY = 0.7;

  //anchor at bottom-center of subject
  const w = fgPlacement.w;
  const h = fgPlacement.h;

  sctx.save();

  //move origin to the contact point under the subject
  sctx.translate(
    fgPlacement.x + w / 2 + dx,
    fgPlacement.y + h + dy
  );

  //project onto the "ground":
  // x' = x + (-k)*y   (shear x by y to create length)
  // y' = squashY*y    (flatten vertically)
  sctx.transform(1, 0, -k, squashY, 0, 0);

  // ===== DEBUG: solid projected silhouette (no blur, no gradients) =====

  // ---------- 1) blurred layer underneath ----------
  const invTan = 1 / Math.tan(elevRad);                 // lower elevation => bigger number
  const blurPx = Math.round(6 * Math.max(0.7, Math.min(2.0, invTan))); // 6..12-ish

  sctx.filter = `blur(${blurPx}px)`;                    // blur the silhouette
  sctx.globalAlpha = 0.30;                              // faint, soft layer

  sctx.globalCompositeOperation = "source-over";
  sctx.drawImage(maskCanvas, -w / 2, -h, w, h);
  sctx.globalCompositeOperation = "source-in";
  sctx.fillStyle = "black";
  sctx.fillRect(-w / 2, -h, w, h);

  // ---------- 2) sharp layer on top ----------
  sctx.filter = "none";
  sctx.globalAlpha = 0.70;                              // stronger, sharper layer
  sctx.globalCompositeOperation = "source-over";
  sctx.drawImage(maskCanvas, -w / 2, -h, w, h);
  sctx.globalCompositeOperation = "source-in";
  sctx.fillStyle = "black";
  sctx.fillRect(-w / 2, -h, w, h);

  // ---------- 3) fade both layers together ----------
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


  //restore and STOP here for debugging
  sctx.restore();


  // --------------------------------------------------------------------
  // Everything below is intentionally disabled for now.
  // Once the debug silhouette looks correct, we’ll re-enable:
  // - layered blur falloff
  // - distance fade
  // - contact shadow strip
  // --------------------------------------------------------------------
}, [bgSrc, fgSrc, fgPlacement, light, maskVersion]);



  return (
    <div style={{ padding: 20, fontFamily: "Figtree"}}>
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
          display: "flex",
          
          gap: 100,
          alignItems: "flex-start",
          flexWrap: "wrap"
        }}
      >
        <div>
          <h3 style={{ margin: "8px 0" }}>Foreground preview</h3>
          {fgSrc ? (
            <div
              style={{
                width: 400,
                height: 400,
                backgroundColor: "rgba(0,0,0,0.2)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
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
            </div>
          ) : (
            <div style={{opacity: 0.7 }}>
              Upload a foreground cutout (PNG with transparency is best)
            </div>
          )}
        </div>

        <div>
          <h3 style={{ margin: "8px 0" }}>Background preview</h3>
          {bgSrc ? (
            <div
              style={{
                width: 500,
                height: 500,
                backgroundColor: "rgba(0,0,0,0.2)",
                borderRadius: 8,
                overflow: "hidden",
              }}
            >
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
            </div>
          ) : (
            <div style={{opacity: 0.7 }}>
              Upload a background image
            </div>
          )}
        </div>
        <div>
        <h3 style={{margin:"8px 0"}}>Composite Preview</h3>
        <canvas
          ref={canvasRef}
          style={{height: "500px", display: "block", backgroundColor: "rgba(0,0,0,0.2)"}}
        />
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
            style={{ width: "100%", display: "block", backgroundColor: "black" }}
          />
        </div>

        <div>
          <h3 style={{ margin: "8px 0" }}>shadow_only (next)</h3>
          <canvas
            ref={shadowRef}
            style={{ width: "700px", display: "block", backgroundColor: "white" }}
          />
        </div>
      </div>
    </div>
  );
}
