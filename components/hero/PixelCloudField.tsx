"use client";

import { useEffect, useRef } from "react";

const CLOUD_SOURCE = "/images/cloud-source-natural.jpg";
const PLANE_SOURCE = "/images/aircraft-generated.png";
const SKY = "#2984ce";
const FLIGHT_DURATION = 20_000;
const FRICTION = 0.84;
const SPRING = 0.075;
// The cloud surface drifts by at most 41px horizontally and 16px vertically.
// Keep a mirrored perimeter offscreen so motion never exposes a hard viewport
// edge or an empty corner.
const CLOUD_OVERSCAN = 52;
// A single continuous cloud surface guarantees there can never be a visible
// layer seam through a connected cloud bank.
const CLOUD_GROUPS = 1;

type Tile = {
  homeX: number;
  homeY: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: string;
  driftGroup: number;
  float: number;
  phase: number;
};

type ForceSource = {
  x: number;
  y: number;
  radius: number;
  strength: number;
};

function isCloud(red: number, green: number, blue: number) {
  return red > 102 && green > 116 && blue > 128 && blue - red < 88;
}

function applyForce(
  tile: Tile,
  source: ForceSource,
  frameScale: number,
  offsetX = 0,
  offsetY = 0,
) {
  const dx = tile.x + offsetX - source.x;
  const dy = tile.y + offsetY - source.y;
  const distance = Math.hypot(dx, dy) || 0.001;
  if (distance >= source.radius) return;

  const force =
    (1 - distance / source.radius) * source.strength * frameScale;
  tile.vx += (dx / distance) * force;
  tile.vy += (dy / distance) * force;
}

export function PixelCloudField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    const cloudsImage = new window.Image();
    const planeImage = new window.Image();
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const pointer = { x: -9999, y: -9999, active: false };

    let width = 0;
    let height = 0;
    let dpr = 1;
    let cellWidth = 8;
    let cellHeight = 8;
    let tileSize = 6;
    let tiles: Tile[] = [];
    let active = new Int32Array(0);
    let base: HTMLCanvasElement | null = null;
    let cloudLayers: HTMLCanvasElement[] = [];
    let planeSprite: HTMLCanvasElement | null = null;
    let frame = 0;
    let resizeFrame = 0;
    let previousTime = performance.now();
    const startedAt = previousTime - FLIGHT_DURATION * 0.36;
    let loadedAssets = 0;
    let ready = false;

    const planeState = (time: number) => {
      const progress = ((time - startedAt) % FLIGHT_DURATION) / FLIGHT_DURATION;
      const planeWidth = Math.max(112, Math.min(166, width * 0.1));
      const flightDeltaX = width * -1.3;
      const verticalTravel = Math.min(height * 0.42, width * 0.32);
      const flightDeltaY = -verticalTravel;
      return {
        x: width * (1.14 - progress * 1.3),
        y: height * 0.37 + (0.5 - progress) * verticalTravel,
        width: planeWidth,
        height: planeWidth * 0.75,
        rotation: Math.atan2(-flightDeltaY, -flightDeltaX),
      };
    };

    const drawPlane = (time: number) => {
      if (!planeSprite) return;
      const plane = planeState(time);
      context.save();
      context.translate(Math.round(plane.x), Math.round(plane.y));
      context.rotate(plane.rotation);
      context.drawImage(
        planeSprite,
        Math.round(-plane.width / 2),
        Math.round(-plane.height / 2),
        Math.round(plane.width),
        Math.round(plane.height),
      );
      context.restore();
    };

    const build = () => {
      if (!cloudsImage.complete || !planeImage.complete) return;

      const bounds = canvas.getBoundingClientRect();
      width = Math.round(bounds.width);
      height = Math.round(bounds.height);
      if (!width || !height) return;

      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);

      const targetCell =
        width < 640 ? 4 : Math.max(4, Math.min(4.75, width / 285));
      const columns = Math.max(42, Math.round(width / targetCell));
      const rows = Math.max(58, Math.round(height / targetCell));
      cellWidth = width / columns;
      cellHeight = height / rows;
      tileSize = Math.min(cellWidth, cellHeight) * 0.72;

      const sampler = document.createElement("canvas");
      sampler.width = columns;
      sampler.height = rows;
      const samplerContext = sampler.getContext("2d", {
        willReadFrequently: true,
      });
      if (!samplerContext) return;

      // The source is a shape/mass map, not a visible photograph. Mapping its
      // full composition into normalized viewport space preserves the cloud
      // banks on portrait screens instead of letting object-fit cropping turn
      // one edge cloud into the entire scene.
      samplerContext.drawImage(
        cloudsImage,
        0,
        0,
        cloudsImage.naturalWidth,
        cloudsImage.naturalHeight,
        0,
        0,
        columns,
        rows,
      );
      const pixels = samplerContext.getImageData(
        0,
        0,
        columns,
        rows,
      ).data;

      const nextTiles: Tile[] = [];
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const index = (row * columns + column) * 4;
          const red = pixels[index];
          const green = pixels[index + 1];
          const blue = pixels[index + 2];
          if (!isCloud(red, green, blue)) continue;

          // Preserve solid cloud cores while thinning marginal source pixels
          // into the scattered square dissolve seen around real cloud edges.
          const cloudDensity = Math.max(
            0.16,
            Math.min(1, (red - 95) / 100),
          );
          const pixelNoise =
            ((column * 73_856_093 + row * 19_349_663) >>> 0) % 101;
          if (pixelNoise / 100 > cloudDensity) continue;

          const normalizedX = (column + 0.5) / columns;
          const normalizedY = (row + 0.5) / rows;
          const copyClearance =
            width < 700 ? 0.94 : width < 1000 ? 0.76 : 0.58;
          const edgeWarp =
            Math.sin(normalizedX * 14.3) * 0.012 +
            Math.sin(normalizedX * 41.7 + 1.2) * 0.007 +
            (pixelNoise / 100 - 0.5) * 0.012;
          const copyX = normalizedX / copyClearance;
          const copyY = Math.abs(normalizedY + edgeWarp - 0.505) / 0.115;
          const copyCorridor =
            copyX < 1 && Math.pow(copyX, 6) + Math.pow(copyY, 6) < 1;
          if (copyCorridor) continue;

          const homeX = (column + 0.5) * cellWidth;
          const homeY = (row + 0.5) * cellHeight;
          const liftedRed = Math.min(255, red + 15);
          const liftedGreen = Math.min(255, green + 12);
          const liftedBlue = Math.min(255, blue + 8);
          nextTiles.push({
            homeX,
            homeY,
            x: homeX,
            y: homeY,
            vx: 0,
            vy: 0,
            color: `rgb(${liftedRed} ${liftedGreen} ${liftedBlue})`,
            driftGroup: 0,
            float: cloudDensity < 0.86 ? (0.86 - cloudDensity) * 7 : 0,
            phase:
              (pixelNoise / 100) * Math.PI * 2 +
              normalizedX * 2.1 +
              normalizedY * 3.7,
          });
        }
      }
      tiles = nextTiles;
      active = new Int32Array(tiles.length);

      base = document.createElement("canvas");
      base.width = canvas.width;
      base.height = canvas.height;
      const baseContext = base.getContext("2d", { alpha: false });
      if (!baseContext) return;
      baseContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      baseContext.fillStyle = SKY;
      baseContext.fillRect(0, 0, width, height);

      cloudLayers = Array.from({ length: CLOUD_GROUPS }, () => {
        const layer = document.createElement("canvas");
        layer.width = Math.round((width + CLOUD_OVERSCAN * 2) * dpr);
        layer.height = Math.round((height + CLOUD_OVERSCAN * 2) * dpr);
        return layer;
      });
      const layerContexts = cloudLayers.map((layer) => {
        const layerContext = layer.getContext("2d");
        layerContext?.setTransform(dpr, 0, 0, dpr, 0, 0);
        return layerContext;
      });
      const half = tileSize / 2;
      for (const tile of tiles) {
        const layerContext = layerContexts[tile.driftGroup];
        if (!layerContext) continue;
        layerContext.fillStyle = tile.color;
        const positionsX = [tile.homeX];
        const positionsY = [tile.homeY];

        // Reflect edge pixels into the overscan region. Combining the reflected
        // X and Y positions also fills all four offscreen corners.
        if (tile.homeX < CLOUD_OVERSCAN) positionsX.push(-tile.homeX);
        if (tile.homeX > width - CLOUD_OVERSCAN) {
          positionsX.push(width * 2 - tile.homeX);
        }
        if (tile.homeY < CLOUD_OVERSCAN) positionsY.push(-tile.homeY);
        if (tile.homeY > height - CLOUD_OVERSCAN) {
          positionsY.push(height * 2 - tile.homeY);
        }

        for (const positionX of positionsX) {
          for (const positionY of positionsY) {
            layerContext.fillRect(
              Math.round(positionX + CLOUD_OVERSCAN - half),
              Math.round(positionY + CLOUD_OVERSCAN - half),
              Math.ceil(tileSize),
              Math.ceil(tileSize),
            );
          }
        }
      }

      planeSprite = document.createElement("canvas");
      planeSprite.width = planeImage.naturalWidth;
      planeSprite.height = planeImage.naturalHeight;
      const planeContext = planeSprite.getContext("2d");
      if (!planeContext) return;
      planeContext.drawImage(planeImage, 0, 0);
      planeContext.globalCompositeOperation = "source-atop";
      planeContext.fillStyle = "rgb(20 38 61 / 78%)";
      planeContext.fillRect(0, 0, planeSprite.width, planeSprite.height);
      planeContext.globalCompositeOperation = "source-over";

      ready = true;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(base, 0, 0);
      for (const layer of cloudLayers) {
        context.drawImage(
          layer,
          Math.round(-CLOUD_OVERSCAN * dpr),
          Math.round(-CLOUD_OVERSCAN * dpr),
        );
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawPlane(reducedMotion ? startedAt + FLIGHT_DURATION * 0.36 : performance.now());
    };

    const tick = (time: number) => {
      frame = requestAnimationFrame(tick);
      if (
        !ready ||
        !base ||
        cloudLayers.length !== CLOUD_GROUPS ||
        document.hidden
      ) {
        return;
      }

      const frameScale = Math.min(2, Math.max(0.5, (time - previousTime) / 16.67));
      previousTime = time;
      const pointerRadius = Math.max(54, Math.min(96, width * 0.065));
      const pointerSource: ForceSource = {
        x: pointer.x,
        y: pointer.y,
        radius: pointerRadius,
        strength: 1.7,
      };
      const plane = planeState(time);
      const cloudDrifts = cloudLayers.map(() => {
        return {
          x:
            Math.sin(time * 0.00028) * 32 +
            Math.sin(time * 0.00011 + 1.4) * 9,
          y: Math.cos(time * 0.00021) * 16,
        };
      });
      const planeCos = Math.cos(plane.rotation);
      const planeSin = Math.sin(plane.rotation);
      const planePoint = (localX: number, localY: number) => ({
        x: plane.x + localX * planeCos - localY * planeSin,
        y: plane.y + localX * planeSin + localY * planeCos,
      });
      const planeSources: ForceSource[] = [
        {
          ...planePoint(-plane.width * 0.34, 0),
          radius: plane.width * 0.2,
          strength: 1.25,
        },
        {
          x: plane.x,
          y: plane.y,
          radius: plane.width * 0.3,
          strength: 1.55,
        },
        {
          ...planePoint(plane.width * 0.32, 0),
          radius: plane.width * 0.2,
          strength: 1.1,
        },
        {
          ...planePoint(0, -plane.height * 0.3),
          radius: plane.width * 0.17,
          strength: 1.1,
        },
        {
          ...planePoint(0, plane.height * 0.3),
          radius: plane.width * 0.17,
          strength: 1.1,
        },
      ];

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.drawImage(base, 0, 0);
      for (let group = 0; group < cloudLayers.length; group += 1) {
        const drift = cloudDrifts[group];
        context.drawImage(
          cloudLayers[group],
          Math.round((drift.x - CLOUD_OVERSCAN) * dpr),
          Math.round((drift.y - CLOUD_OVERSCAN) * dpr),
        );
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      let activeCount = 0;
      for (let index = 0; index < tiles.length; index += 1) {
        const tile = tiles[index];
        const drift = cloudDrifts[tile.driftGroup];
        const edgeX = Math.sin(time * 0.00042 + tile.phase) * tile.float;
        const edgeY =
          Math.cos(time * 0.00036 + tile.phase * 1.37) * tile.float * 0.65;
        const offsetX = drift.x + edgeX;
        const offsetY = drift.y + edgeY;
        if (pointer.active) {
          applyForce(tile, pointerSource, frameScale, offsetX, offsetY);
        }
        const planeDeltaX = tile.x + offsetX - plane.x;
        const planeDeltaY = tile.y + offsetY - plane.y;
        const planeLocalX =
          planeDeltaX * planeCos + planeDeltaY * planeSin;
        const planeLocalY =
          -planeDeltaX * planeSin + planeDeltaY * planeCos;
        const nearPlane =
          Math.abs(planeLocalX) < plane.width * 0.72 &&
          Math.abs(planeLocalY) < plane.height * 0.72;
        if (nearPlane) {
          for (const source of planeSources) {
            applyForce(tile, source, frameScale, offsetX, offsetY);
          }
        }

        if (
          planeLocalX > plane.width * 0.15 &&
          planeLocalX < plane.width * 1.8 &&
          Math.abs(planeLocalY) < plane.height * 0.25
        ) {
          const wakeStrength =
            (1 - planeLocalX / (plane.width * 1.8)) *
            0.18 *
            frameScale;
          const wakeDirection = planeLocalY >= 0 ? 1 : -1;
          tile.vx += -planeSin * wakeDirection * wakeStrength;
          tile.vy += planeCos * wakeDirection * wakeStrength;
        }

        tile.vx *= Math.pow(FRICTION, frameScale);
        tile.vy *= Math.pow(FRICTION, frameScale);
        tile.x += tile.vx * frameScale;
        tile.y += tile.vy * frameScale;
        tile.x += (tile.homeX - tile.x) * SPRING * frameScale;
        tile.y += (tile.homeY - tile.y) * SPRING * frameScale;

        if (
          Math.abs(tile.x - tile.homeX) > 0.25 ||
          Math.abs(tile.y - tile.homeY) > 0.25 ||
          tile.float > 0
        ) {
          active[activeCount] = index;
          activeCount += 1;
          context.fillStyle = SKY;
          context.fillRect(
            Math.round(tile.homeX + drift.x - cellWidth / 2),
            Math.round(tile.homeY + drift.y - cellHeight / 2),
            Math.ceil(cellWidth),
            Math.ceil(cellHeight),
          );
        }
      }

      const half = tileSize / 2;
      for (let index = 0; index < activeCount; index += 1) {
        const tile = tiles[active[index]];
        const drift = cloudDrifts[tile.driftGroup];
        const edgeX = Math.sin(time * 0.00042 + tile.phase) * tile.float;
        const edgeY =
          Math.cos(time * 0.00036 + tile.phase * 1.37) * tile.float * 0.65;
        context.fillStyle = tile.color;
        context.fillRect(
          Math.round(tile.x + drift.x + edgeX - half),
          Math.round(tile.y + drift.y + edgeY - half),
          Math.ceil(tileSize),
          Math.ceil(tileSize),
        );
      }

      drawPlane(time);
    };

    const onAssetLoad = () => {
      loadedAssets += 1;
      if (loadedAssets === 2) build();
    };

    const onPointerMove = (event: PointerEvent) => {
      const bounds = canvas.getBoundingClientRect();
      pointer.x = event.clientX - bounds.left;
      pointer.y = event.clientY - bounds.top;
      pointer.active = true;
    };

    const onPointerDown = (event: PointerEvent) => {
      onPointerMove(event);
    };

    const clearPointer = () => {
      pointer.active = false;
    };

    const onResize = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        build();
      });
    };

    const onVisibilityChange = () => {
      previousTime = performance.now();
    };

    cloudsImage.addEventListener("load", onAssetLoad);
    planeImage.addEventListener("load", onAssetLoad);
    cloudsImage.src = CLOUD_SOURCE;
    planeImage.src = PLANE_SOURCE;
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibilityChange);

    if (!reducedMotion) {
      window.addEventListener("pointerdown", onPointerDown, { passive: true });
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointerup", clearPointer, { passive: true });
      window.addEventListener("pointercancel", clearPointer, { passive: true });
      document.addEventListener("mouseleave", clearPointer);
      window.addEventListener("blur", clearPointer);
      frame = requestAnimationFrame(tick);
    }

    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resizeFrame);
      cloudsImage.removeEventListener("load", onAssetLoad);
      planeImage.removeEventListener("load", onAssetLoad);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", clearPointer);
      window.removeEventListener("pointercancel", clearPointer);
      document.removeEventListener("mouseleave", clearPointer);
      window.removeEventListener("blur", clearPointer);
    };
  }, []);

  return <canvas ref={canvasRef} className="hero-effects" aria-hidden="true" />;
}
