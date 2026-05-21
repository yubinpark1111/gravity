"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type SketchP5 = typeof import("p5")["default"];
type P5Instance = InstanceType<SketchP5>;

type ParticleState = "stable" | "disturbed" | "attracted" | "returning";
type ParticleType = "text" | "drawing";
type ToolMode = "draw" | "attract";

type Particle = {
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  vx: number;
  vy: number;
  type: ParticleType;
  life: number;
  size: number;
  state: ParticleState;
  seed: number;
  groupId?: number;
};

type Point = {
  x: number;
  y: number;
};

type TextGroup = {
  id: number;
  text: string;
  x: number;
  y: number;
  size: number;
};

const CONFIG = {
  particleSpacing: 8,
  textSampleStep: 9,
  attractionStrength: 0.09,
  returnStrength: 0.055,
  damping: 0.86,
  noiseStrength: 22,
  interactionRadius: 460,
  particleSize: 3.8,
  trailAlpha: 255,
  maxParticles: 3200,
  drawingSampleDistance: 10,
  disturbedDelayMs: 150,
  holdToAttractMs: 120,
  mouseDriftLimit: 7,
};

const PALETTE = [
  [26, 26, 26],
  [196, 34, 52],
  [26, 86, 168],
  [12, 124, 86],
  [224, 120, 32],
];

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  const parsed = Number.parseInt(value.length === 3 ? value.replace(/(.)/g, "$1$1") : value, 16);
  return [(parsed >> 16) & 255, (parsed >> 8) & 255, parsed & 255];
}

function mixRgb(a: number[], b: number[], amount: number) {
  return [
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ];
}

export default function LivingDrawingTool() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const p5Ref = useRef<P5Instance | null>(null);
  const toolModeRef = useRef<ToolMode>("draw");
  const textSizeRef = useRef(160);
  const particleSizeRef = useRef(CONFIG.particleSize);
  const particleLimitRef = useRef(CONFIG.maxParticles);
  const particleColorRef = useRef("#1a1a1a");
  const colorRandomnessRef = useRef(65);
  const selectedTextGroupIdRef = useRef<number | null>(null);
  const apiRef = useRef<{
    addTextParticles: (text: string, size: number) => void;
    updateSelectedText: (text: string, size: number) => boolean;
    setParticleLimit: (limit: number) => void;
    clearParticles: () => void;
  } | null>(null);
  const [text, setText] = useState("ALIVE");
  const [textSize, setTextSizeState] = useState(160);
  const [particleSize, setParticleSizeState] = useState(CONFIG.particleSize);
  const [particleLimit, setParticleLimitState] = useState(CONFIG.maxParticles);
  const [particleColor, setParticleColorState] = useState("#1a1a1a");
  const [colorRandomness, setColorRandomnessState] = useState(65);
  const [toolMode, setToolModeState] = useState<ToolMode>("draw");
  const [selectedTextGroupId, setSelectedTextGroupId] = useState<number | null>(null);

  useEffect(() => {
    let disposed = false;

    async function bootSketch() {
      const P5 = (await import("p5")).default;
      if (disposed || !hostRef.current) return;

      const sketch = (p: P5Instance) => {
        let particles: Particle[] = [];
        let textGroups: TextGroup[] = [];
        let nextTextGroupId = 1;
        let drawingPath: Point[] = [];
        let isPointerDown = false;
        let pointerDownAt = 0;
        let pointerStart: Point = { x: 0, y: 0 };
        let pressurePoint: Point = { x: 0, y: 0 };
        let mode: ParticleState = "stable";
        let grainLayer: ReturnType<P5Instance["createImage"]>;
        let canvasElement: HTMLCanvasElement | null = null;

        p.setup = () => {
          const canvas = p.createCanvas(p.windowWidth, p.windowHeight);
          canvas.parent(hostRef.current as HTMLDivElement);
          canvasElement = canvas.elt as HTMLCanvasElement;
          p.pixelDensity(1);
          p.colorMode(p.RGB, 255, 255, 255, 255);
          p.noFill();
          grainLayer = makeGrainLayer();
          addTextParticles("ALIVE", p.width * 0.5, p.height * 0.49, textSizeRef.current, false);

          apiRef.current = {
            addTextParticles: (value: string, size: number) => {
              addTextParticles(value, p.width * 0.5, p.height * 0.5, size);
            },
            updateSelectedText: (value: string, size: number) => {
              return updateSelectedText(value, size);
            },
            setParticleLimit: (limit: number) => {
              particles = clampParticles(particles, limit);
            },
            clearParticles: () => {
              particles = [];
              textGroups = [];
              drawingPath = [];
              clearSelectedTextGroup();
            },
          };
        };

        p.draw = () => {
          drawAtmosphere();
          updateDrawing();
          updateParticles();
          drawParticles();
          drawCurrentPath();
          drawGrain();
        };

        p.windowResized = () => {
          p.resizeCanvas(p.windowWidth, p.windowHeight);
          grainLayer = makeGrainLayer();
        };

        p.mousePressed = (event?: MouseEvent) => {
          if (!isCanvasPointerEvent(event) || !isInsideCanvas()) return;
          isPointerDown = true;
          pointerDownAt = p.millis();
          pointerStart = { x: p.mouseX, y: p.mouseY };
          pressurePoint = { x: p.mouseX, y: p.mouseY };
          drawingPath = toolModeRef.current === "draw" ? [pointerStart] : [];
          mode = toolModeRef.current === "attract" ? "disturbed" : "stable";
        };

        p.mouseDragged = () => {
          if (!isPointerDown || !isInsideCanvas()) return;
          pressurePoint = { x: p.mouseX, y: p.mouseY };
          if (toolModeRef.current !== "draw") return;
          const last = drawingPath[drawingPath.length - 1];
          if (p.dist(last.x, last.y, p.mouseX, p.mouseY) >= 2.5) {
            drawingPath.push({ x: p.mouseX, y: p.mouseY });
          }
        };

        p.mouseReleased = () => {
          if (!isPointerDown) return;
          isPointerDown = false;
          if (toolModeRef.current === "draw") {
            const dragDistance = p.dist(pointerStart.x, pointerStart.y, p.mouseX, p.mouseY);
            if (drawingPath.length > 2 && dragDistance > CONFIG.mouseDriftLimit) {
              sampleDrawingPath(drawingPath);
            } else {
              selectTextGroupAt(p.mouseX, p.mouseY);
            }
          }
          drawingPath = [];
          mode = "returning";
          for (const particle of particles) particle.state = "returning";
        };

        function drawAtmosphere() {
          p.blendMode(p.BLEND);
          p.background(248, 248, 244, CONFIG.trailAlpha);
        }

        function addTextParticles(value: string, centerX: number, centerY: number, size: number, selectAfter = true) {
          const textValue = value.trim();
          if (!textValue) return;
          const groupId = nextTextGroupId;
          nextTextGroupId += 1;
          textGroups.push({ id: groupId, text: textValue, x: centerX, y: centerY, size });
          particles = clampParticles([...particles, ...buildTextParticles(textValue, centerX, centerY, size, groupId)]);
          if (selectAfter) selectTextGroup(groupId);
        }

        function buildTextParticles(value: string, centerX: number, centerY: number, size: number, groupId: number) {
          const buffer = document.createElement("canvas");
          buffer.width = Math.max(420, p.width);
          buffer.height = Math.max(220, Math.floor(size * 1.9));
          const context = buffer.getContext("2d", { willReadFrequently: true });
          if (!context) return [];

          context.clearRect(0, 0, buffer.width, buffer.height);
          context.fillStyle = "#fff";
          context.textAlign = "center";
          context.textBaseline = "middle";
          context.font = `700 ${size}px Helvetica, Arial, sans-serif`;
          context.fillText(value, buffer.width / 2, buffer.height / 2);
          const pixels = context.getImageData(0, 0, buffer.width, buffer.height).data;

          const next: Particle[] = [];
          const xOffset = centerX - buffer.width / 2;
          const yOffset = centerY - buffer.height / 2;

          for (let y = 0; y < buffer.height; y += CONFIG.textSampleStep) {
            for (let x = 0; x < buffer.width; x += CONFIG.textSampleStep) {
              const index = 4 * (y * buffer.width + x) + 3;
              if (pixels[index] > 80 && p.noise(x * 0.05, y * 0.05) > 0.28) {
                next.push(makeParticle(x + xOffset, y + yOffset, "text", groupId));
              }
            }
          }

          return next;
        }

        function updateSelectedText(value: string, size: number) {
          const groupId = selectedTextGroupIdRef.current;
          const textValue = value.trim();
          if (!groupId || !textValue) return false;

          const group = textGroups.find((item) => item.id === groupId);
          if (!group) return false;

          group.text = textValue;
          group.size = size;
          particles = particles.filter((particle) => particle.groupId !== groupId);
          particles = clampParticles([
            ...particles,
            ...buildTextParticles(textValue, group.x, group.y, size, groupId),
          ]);
          selectTextGroup(groupId);
          return true;
        }

        function sampleDrawingPath(path: Point[]) {
          if (path.length < 2) return;
          const sampled: Particle[] = [];
          let carry = 0;

          for (let i = 1; i < path.length; i += 1) {
            const a = path[i - 1];
            const b = path[i];
            const segmentLength = p.dist(a.x, a.y, b.x, b.y);
            if (segmentLength < 0.01) continue;

            for (let d = carry; d < segmentLength; d += CONFIG.drawingSampleDistance) {
              const t = d / segmentLength;
              sampled.push(makeParticle(p.lerp(a.x, b.x, t), p.lerp(a.y, b.y, t), "drawing"));
            }
            carry = (carry + segmentLength) % CONFIG.drawingSampleDistance;
          }

          particles = clampParticles([...particles, ...sampled]);
        }

        function updateDrawing() {
          if (!isPointerDown || toolModeRef.current !== "attract") return;
          const held = p.millis() - pointerDownAt;
          const drift = p.dist(pointerStart.x, pointerStart.y, p.mouseX, p.mouseY);
          mode = held > CONFIG.holdToAttractMs || drift > CONFIG.mouseDriftLimit ? "attracted" : "disturbed";
        }

        function updateParticles() {
          const mouse = isPointerDown ? pressurePoint : { x: p.mouseX, y: p.mouseY };
          const isAttracting = isPointerDown && toolModeRef.current === "attract";

          for (const particle of particles) {
            if (isAttracting) {
              const d = p.dist(mouse.x, mouse.y, particle.x, particle.y);
              const near = 1 - smoothstep(0, CONFIG.interactionRadius, d);
              if (near > 0.02) {
                particle.state = mode;
                applyNoiseDistortion(particle, near);
                if (mode === "attracted") applyAttraction(particle, mouse.x, mouse.y, near);
              } else {
                particle.state = "stable";
                applyReturnForce(particle, 0.45);
              }
            } else {
              particle.state = particle.state === "returning" ? "returning" : "stable";
              applyReturnForce(particle, 1);
            }

            particle.vx *= CONFIG.damping;
            particle.vy *= CONFIG.damping;
            particle.x += particle.vx;
            particle.y += particle.vy;

            const homeDistance = p.dist(particle.x, particle.y, particle.homeX, particle.homeY);
            if (!isPointerDown && homeDistance < 0.35 && Math.abs(particle.vx) + Math.abs(particle.vy) < 0.08) {
              particle.x = particle.homeX;
              particle.y = particle.homeY;
              particle.state = "stable";
            }
          }
        }

        function drawParticles() {
          p.blendMode(p.BLEND);

          for (let i = 0; i < particles.length; i += 1) {
            const particle = particles[i];
            const color = getParticleColor(particle, i);
            const speed = Math.min(1, p.dist(0, 0, particle.vx, particle.vy) / 9);
            const isSelected = particle.groupId === selectedTextGroupIdRef.current;
            const alpha = isSelected ? 255 : 225 + speed * 20;

            p.strokeWeight(particle.size * particleSizeRef.current * (isSelected ? 1.18 : 1));
            p.stroke(color[0], color[1], color[2], alpha);
            p.point(particle.x, particle.y);

            if (i > 0 && i % 8 === 0) {
              const neighbor = particles[i - 1];
              const linkDistance = p.dist(particle.x, particle.y, neighbor.x, neighbor.y);
              if (linkDistance < CONFIG.particleSpacing * 2.8) {
                p.strokeWeight(0.8);
                p.stroke(color[0], color[1], color[2], 90);
                p.line(particle.x, particle.y, neighbor.x, neighbor.y);
              }
            }

            if (speed > 0.12) {
              p.strokeWeight(1);
              p.stroke(color[0], color[1], color[2], 105);
              p.line(particle.x, particle.y, particle.x - particle.vx * 2.6, particle.y - particle.vy * 2.6);
            }
          }

          p.blendMode(p.BLEND);
        }

        function drawCurrentPath() {
          if (toolModeRef.current !== "draw" || drawingPath.length < 2) return;
          p.blendMode(p.BLEND);
          p.noFill();
          p.stroke(24, 24, 24, 210);
          p.strokeWeight(Math.max(1.2, particleSizeRef.current * 0.42));
          p.beginShape();
          for (const point of drawingPath) p.vertex(point.x, point.y);
          p.endShape();
          p.blendMode(p.BLEND);
        }

        function applyAttraction(particle: Particle, mouseX: number, mouseY: number, amount: number) {
          const pull = CONFIG.attractionStrength * (0.15 + amount * amount);
          const swirl = p.noise(particle.seed, p.frameCount * 0.012) * p.TWO_PI * 2;
          const dx = mouseX - particle.x;
          const dy = mouseY - particle.y;
          particle.vx += dx * pull + Math.cos(swirl) * amount * 0.42;
          particle.vy += dy * pull + Math.sin(swirl) * amount * 0.42;
        }

        function applyReturnForce(particle: Particle, scale: number) {
          const spring = CONFIG.returnStrength * scale;
          particle.vx += (particle.homeX - particle.x) * spring;
          particle.vy += (particle.homeY - particle.y) * spring;

          const homeDistance = p.dist(particle.x, particle.y, particle.homeX, particle.homeY);
          if (homeDistance > 1) {
            const shimmer = Math.min(1, homeDistance / 90) * 0.35;
            const angle = p.noise(particle.seed + 30, p.frameCount * 0.014) * p.TWO_PI;
            particle.vx += Math.cos(angle) * shimmer;
            particle.vy += Math.sin(angle) * shimmer;
          }
        }

        function applyNoiseDistortion(particle: Particle, amount: number) {
          const n = p.noise(particle.homeX * 0.008, particle.homeY * 0.008, p.frameCount * 0.012 + particle.seed);
          const angle = n * p.TWO_PI * 2.5;
          const strength = CONFIG.noiseStrength * amount * 0.018;
          particle.vx += Math.cos(angle) * strength;
          particle.vy += Math.sin(angle) * strength;
        }

        function smoothstep(edge0: number, edge1: number, x: number) {
          const t = p.constrain((x - edge0) / (edge1 - edge0), 0, 1);
          return t * t * (3 - 2 * t);
        }

        function makeParticle(x: number, y: number, type: ParticleType, groupId?: number): Particle {
          return {
            x,
            y,
            homeX: x,
            homeY: y,
            vx: 0,
            vy: 0,
            type,
            life: 1,
            size: type === "text" ? 1.05 : 0.9,
            state: "stable",
            seed: p.random(1000),
            groupId,
          };
        }

        function clampParticles(next: Particle[], limit = particleLimitRef.current) {
          if (next.length <= limit) return next;
          return next.slice(next.length - limit);
        }

        function getParticleColor(particle: Particle, index: number) {
          const base = hexToRgb(particleColorRef.current);
          const paletteIndex = Math.abs(Math.floor(particle.seed + index)) % PALETTE.length;
          return mixRgb(base, PALETTE[paletteIndex], colorRandomnessRef.current / 100);
        }

        function makeGrainLayer() {
          const layer = p.createImage(p.windowWidth, p.windowHeight);
          layer.loadPixels();
          for (let i = 0; i < layer.pixels.length; i += 4) {
            const value = p.random(255);
            layer.pixels[i] = value;
            layer.pixels[i + 1] = value;
            layer.pixels[i + 2] = value;
            layer.pixels[i + 3] = p.random(10, 28);
          }
          layer.updatePixels();
          return layer;
        }

        function drawGrain() {
          p.blendMode(p.MULTIPLY);
          p.tint(255, 12);
          p.image(grainLayer, 0, 0, p.width, p.height);
          p.noTint();
          p.blendMode(p.BLEND);
        }

        function isInsideCanvas() {
          return p.mouseX >= 0 && p.mouseX <= p.width && p.mouseY >= 0 && p.mouseY <= p.height;
        }

        function isCanvasPointerEvent(event?: MouseEvent) {
          return !event || event.target === canvasElement;
        }

        function selectTextGroupAt(x: number, y: number) {
          let nearestGroupId: number | null = null;
          let nearestDistance = Infinity;
          const hitRadius = Math.max(18, particleSizeRef.current * 5);

          for (const particle of particles) {
            if (particle.type !== "text" || !particle.groupId) continue;
            const distance = p.dist(x, y, particle.x, particle.y);
            if (distance < hitRadius && distance < nearestDistance) {
              nearestDistance = distance;
              nearestGroupId = particle.groupId;
            }
          }

          if (nearestGroupId) {
            selectTextGroup(nearestGroupId);
          } else {
            clearSelectedTextGroup();
          }
        }

        function selectTextGroup(groupId: number) {
          const group = textGroups.find((item) => item.id === groupId);
          if (!group) return;
          selectedTextGroupIdRef.current = groupId;
          setSelectedTextGroupId(groupId);
          setText(group.text);
          setTextSize(group.size);
        }

        function clearSelectedTextGroup() {
          selectedTextGroupIdRef.current = null;
          setSelectedTextGroupId(null);
        }
      };

      p5Ref.current = new P5(sketch);
    }

    bootSketch();

    return () => {
      disposed = true;
      p5Ref.current?.remove();
      p5Ref.current = null;
      apiRef.current = null;
    };
  }, []);

  function submitText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const updated = selectedTextGroupId ? apiRef.current?.updateSelectedText(text, textSize) : false;
    if (!updated) apiRef.current?.addTextParticles(text, textSize);
  }

  function setToolMode(nextMode: ToolMode) {
    toolModeRef.current = nextMode;
    setToolModeState(nextMode);
  }

  function setTextSize(nextSize: number) {
    textSizeRef.current = nextSize;
    setTextSizeState(nextSize);
  }

  function setParticleSize(nextSize: number) {
    particleSizeRef.current = nextSize;
    setParticleSizeState(nextSize);
  }

  function setParticleLimit(nextLimit: number) {
    particleLimitRef.current = nextLimit;
    setParticleLimitState(nextLimit);
    apiRef.current?.setParticleLimit(nextLimit);
  }

  function setParticleColor(nextColor: string) {
    particleColorRef.current = nextColor;
    setParticleColorState(nextColor);
  }

  function setColorRandomness(nextRandomness: number) {
    colorRandomnessRef.current = nextRandomness;
    setColorRandomnessState(nextRandomness);
  }

  return (
    <main className="toolShell">
      <section className="controlBar" aria-label="Drawing controls">
        <form className="textForm" onSubmit={submitText}>
          <input
            aria-label="Text to convert into particles"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Type text"
          />
          <button type="submit">{selectedTextGroupId ? "Update Text" : "Add Text"}</button>
        </form>
        <div className="modeToggle" aria-label="Tool mode">
          <button
            type="button"
            className={toolMode === "draw" ? "active" : ""}
            aria-pressed={toolMode === "draw"}
            onClick={() => setToolMode("draw")}
          >
            Draw
          </button>
          <button
            type="button"
            className={toolMode === "attract" ? "active" : ""}
            aria-pressed={toolMode === "attract"}
            onClick={() => setToolMode("attract")}
          >
            Attract
          </button>
        </div>
        <label className="sizeControl">
          <span>Text Size</span>
          <input
            aria-label="Text particle size"
            type="range"
            min="50"
            max="500"
            step="10"
            value={textSize}
            onChange={(event) => setTextSize(Number(event.target.value))}
          />
          <output>{textSize}</output>
        </label>
        <label className="sizeControl">
          <span>Particle Size</span>
          <input
            aria-label="Particle size"
            type="range"
            min="1"
            max="12"
            step="0.5"
            value={particleSize}
            onChange={(event) => setParticleSize(Number(event.target.value))}
          />
          <output>{particleSize}</output>
        </label>
        <label className="sizeControl">
          <span>Particle Count</span>
          <input
            aria-label="Particle count"
            type="range"
            min="500"
            max="12000"
            step="100"
            value={particleLimit}
            onChange={(event) => setParticleLimit(Number(event.target.value))}
          />
          <output>{particleLimit}</output>
        </label>
        <label className="colorControl">
          <span>Particle Color</span>
          <input
            aria-label="Particle color"
            type="color"
            value={particleColor}
            onChange={(event) => setParticleColor(event.target.value)}
          />
        </label>
        <label className="sizeControl">
          <span>Color Random</span>
          <input
            aria-label="Color randomness"
            type="range"
            min="0"
            max="100"
            step="5"
            value={colorRandomness}
            onChange={(event) => setColorRandomness(Number(event.target.value))}
          />
          <output>{colorRandomness}</output>
        </label>
        <button type="button" onClick={() => apiRef.current?.clearParticles()}>
          Clear
        </button>
        <span className="hint">
          Draw stores strokes. Click a text shape to edit it. Attract pulls particles while pressed.
        </span>
      </section>
      <div ref={hostRef} className="canvasHost" />
    </main>
  );
}
