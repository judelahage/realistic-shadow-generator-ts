# Realistic Shadow Generator

A small web app that generates more realistic drop shadows for a cutout (foreground) image on top of a background image. Upload a transparent PNG cutout, pick a background, and adjust light direction to preview the composite.

## Features
- Upload a **foreground cutout** (PNG with transparency recommended)
- Upload a **background** image
- Optional **depth map** input (if supported in your build)
- Light controls (angle + elevation)
- Multiple preview outputs (foreground, background, composite, debug views)

## Tech Stack
- React + TypeScript
- Canvas-based rendering

## Getting Started

```bash
npm install
npm run dev
