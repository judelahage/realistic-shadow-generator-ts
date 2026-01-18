import { useState } from "react";

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
  const [depthSrc, setDepthSrc] = useState<string | null>(null); // optional, not used yet

  const [light, setLight] = useState<Light>({ angle: 45, elev: 35 });

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

      {/* Light controls (stored only for now) */}
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

      <p style={{ marginTop: 16, opacity: 0.7 }}>
        Next: draw a composite preview on a canvas, then generate shadow_only + mask_debug.
      </p>
    </div>
  );
}
