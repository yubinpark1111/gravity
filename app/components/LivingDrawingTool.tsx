"use client";

import { FormEvent, useEffect, useRef, useState } from "react";

type SketchP5 = typeof import("p5")["default"];
type P5Instance = InstanceType<SketchP5>;

type ParticleState = "stable" | "disturbed" | "attracted" | "returning";
type ParticleType = "text" | "drawing" | "image";
type ToolMode = "select" | "draw" | "attract";
type TransformMode = "none" | "move" | "scale" | "rotate";
type CanvasRatio = "1:1" | "4:3" | "3:4" | "16:9" | "9:16";
type TextFontId = "sans" | "serif" | "baskerville" | "didot" | "slab" | "script" | "brush" | "mono";

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
  rgb?: number[];
};

type Point = {
  x: number;
  y: number;
};

type ObjectGroup = {
  id: number;
  type: ParticleType;
  x: number;
  y: number;
  particleSize: number;
  color: string;
  lineWidth: number;
  lineColor?: string;
  randomSeed: number;
  density: number;
  rotation?: number;
  text?: string;
  size?: number;
  letterSpacing?: number;
  fontId?: TextFontId;
  path?: Point[];
  imageDataUrl?: string;
  imageElement?: HTMLImageElement;
  imageWidth?: number;
  imageHeight?: number;
};

type HistorySnapshot = {
  groups: ObjectGroup[];
  particles: Particle[];
  nextGroupId: number;
  selectedGroupIds: number[];
  selectedGroupId: number | null;
  canvasRatio: CanvasRatio;
};

type RecordingClip = {
  id: number;
  blob: Blob;
  url: string;
  filename: string;
  durationMs: number;
  size: number;
};

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const CONFIG = {
  particleSpacing: 8,
  textSampleStep: 9,
  attractionStrength: 0.072,
  orbitStrength: 0.24,
  returnStrength: 0.055,
  damping: 0.89,
  noiseStrength: 22,
  interactionRadius: 560,
  particleSize: 3.8,
  trailAlpha: 255,
  maxParticles: 3200,
  drawingSampleDistance: 10,
  disturbedDelayMs: 150,
  holdToAttractMs: 120,
  mouseDriftLimit: 7,
  collisionStrength: 0.86,
  collisionBounce: 0.18,
  collisionCellSize: 30,
  collisionMaxChecks: 2600,
  interGroupCollisionStrength: 0.42,
  interGroupCollisionMaxChecks: 5200,
};

const INITIAL_TEXT = "Hello";
const INITIAL_KOREAN_TEXT = "안녕하세요";
const INITIAL_PRESET = {
  size: 140,
  backLetterSpacing: -3,
  frontLetterSpacing: -4,
  backFontId: "sans" as TextFontId,
  frontFontId: "brush" as TextFontId,
  particleSize: 6,
  density: 7700,
  frontLineWidth: 1.2,
  backLineWidth: 0.25,
  frontColor: "#000000",
  frontLineColor: "#ffffff",
  backColor: "#ffffff",
  backLineColor: "#000000",
};

const CANVAS_RATIOS: Record<CanvasRatio, number> = {
  "1:1": 1,
  "4:3": 4 / 3,
  "3:4": 3 / 4,
  "16:9": 16 / 9,
  "9:16": 9 / 16,
};

const MAX_UNDO_STEPS = 40;
const PNG_EXPORT_PPI = 150;

const TEXT_FONT_OPTIONS: Array<{ id: TextFontId; label: string; stack: string }> = [
  { id: "sans", label: "Sans / Helvetica", stack: "Helvetica Neue, Helvetica, Arial, sans-serif" },
  { id: "serif", label: "Serif / Georgia", stack: "Georgia, Times New Roman, serif" },
  { id: "baskerville", label: "Baskerville", stack: "Baskerville, Georgia, serif" },
  { id: "didot", label: "Didot / Bodoni", stack: "Didot, Bodoni 72, Times New Roman, serif" },
  { id: "slab", label: "Slab / Rockwell", stack: "Rockwell, American Typewriter, Georgia, serif" },
  { id: "script", label: "Script / Snell", stack: "Snell Roundhand, Apple Chancery, cursive" },
  { id: "brush", label: "Brush Script", stack: "Brush Script MT, Apple Chancery, cursive" },
  { id: "mono", label: "Mono / Courier", stack: "Courier New, Courier, monospace" },
];

function getTextFontStack(fontId: TextFontId) {
  return TEXT_FONT_OPTIONS.find((font) => font.id === fontId)?.stack ?? TEXT_FONT_OPTIONS[0].stack;
}

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  const parsed = Number.parseInt(value.length === 3 ? value.replace(/(.)/g, "$1$1") : value, 16);
  return [(parsed >> 16) & 255, (parsed >> 8) & 255, parsed & 255];
}

function writeUint32(target: Uint8Array, offset: number, value: number) {
  target[offset] = (value >>> 24) & 255;
  target[offset + 1] = (value >>> 16) & 255;
  target[offset + 2] = (value >>> 8) & 255;
  target[offset + 3] = value & 255;
}

function getCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const PNG_CRC_TABLE = getCrcTable();

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = PNG_CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function createPngPhysChunk(ppi: number) {
  const pixelsPerMeter = Math.round(ppi / 0.0254);
  const type = new TextEncoder().encode("pHYs");
  const data = new Uint8Array(9);
  writeUint32(data, 0, pixelsPerMeter);
  writeUint32(data, 4, pixelsPerMeter);
  data[8] = 1;

  const chunk = new Uint8Array(4 + type.length + data.length + 4);
  writeUint32(chunk, 0, data.length);
  chunk.set(type, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(type.length + data.length);
  crcInput.set(type, 0);
  crcInput.set(data, type.length);
  writeUint32(chunk, 8 + data.length, crc32(crcInput));
  return chunk;
}

function addPngPpiMetadata(bytes: Uint8Array, ppi: number) {
  const pngSignatureLength = 8;
  const ihdrChunkLength = 4 + 4 + 13 + 4;
  if (bytes.length < pngSignatureLength + ihdrChunkLength) return bytes;

  const insertAt = pngSignatureLength + ihdrChunkLength;
  const physChunk = createPngPhysChunk(ppi);
  const next = new Uint8Array(bytes.length + physChunk.length);
  next.set(bytes.slice(0, insertAt), 0);
  next.set(physChunk, insertAt);
  next.set(bytes.slice(insertAt), insertAt + physChunk.length);
  return next;
}

type H264EncoderFactory = {
  createH264MP4Encoder: () => Promise<any>;
};

let h264EncoderLoader: Promise<H264EncoderFactory> | null = null;

function loadH264Encoder() {
  const currentWindow = window as typeof window & { HME?: H264EncoderFactory };
  if (currentWindow.HME) return Promise.resolve(currentWindow.HME);
  if (h264EncoderLoader) return h264EncoderLoader;

  h264EncoderLoader = fetch("/vendor/h264-mp4-encoder.web.js").then(async (response) => {
    if (!response.ok) throw new Error("H264 encoder failed to load");
    const source = await response.text();
    const factory = new Function(`${source}; return HME;`)() as H264EncoderFactory;
    currentWindow.HME = factory;
    return factory;
  });

  return h264EncoderLoader;
}

export default function LivingDrawingTool() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const p5Ref = useRef<P5Instance | null>(null);
  const toolModeRef = useRef<ToolMode>("select");
  const textSizeRef = useRef(INITIAL_PRESET.size);
  const letterSpacingRef = useRef(INITIAL_PRESET.frontLetterSpacing);
  const textFontRef = useRef<TextFontId>(INITIAL_PRESET.frontFontId);
  const particleSizeRef = useRef(INITIAL_PRESET.particleSize);
  const particleLimitRef = useRef(INITIAL_PRESET.density);
  const particleColorRef = useRef(INITIAL_PRESET.frontColor);
  const lineWidthRef = useRef(INITIAL_PRESET.frontLineWidth);
  const lineColorRef = useRef(INITIAL_PRESET.frontLineColor);
  const canvasRatioRef = useRef<CanvasRatio>("4:3");
  const randomSeedRef = useRef(0);
  const selectedGroupIdRef = useRef<number | null>(null);
  const selectedGroupIdsRef = useRef<number[]>([]);
  const recordingStartedAtRef = useRef(0);
  const recordingTimerRef = useRef<number | null>(null);
  const recordingClipsRef = useRef<RecordingClip[]>([]);
  const apiRef = useRef<{
    addTextParticles: (text: string, size: number) => void;
    addImageParticles: (dataUrl: string) => void;
    updateSelectedText: (text: string, size: number) => boolean;
    updateSelectedTextContent: (text: string) => boolean;
    updateSelectedTextSize: (size: number) => boolean;
    updateSelectedLetterSpacing: (spacing: number) => boolean;
    updateSelectedFont: (fontId: TextFontId) => boolean;
    updateSelectedParticleSize: (size: number) => boolean;
    updateSelectedColor: (color: string) => boolean;
    updateSelectedLineWidth: (width: number) => boolean;
    updateSelectedLineColor: (color: string) => boolean;
    updateSelectedRandomSeed: (seed: number) => boolean;
    setParticleLimit: (limit: number) => void;
    setCanvasRatio: (ratio: CanvasRatio) => void;
    exportPng: () => string | null;
    exportSvg: () => string;
    startRecording: (onComplete: (blob: Blob, extension: string) => void) => Promise<boolean>;
    stopRecording: () => void;
    deleteSelectedGroup: () => boolean;
    clearParticles: () => void;
    undo: () => boolean;
  } | null>(null);
  const [text, setText] = useState(INITIAL_TEXT);
  const [textSize, setTextSizeState] = useState(INITIAL_PRESET.size);
  const [letterSpacing, setLetterSpacingState] = useState(INITIAL_PRESET.frontLetterSpacing);
  const [textFont, setTextFontState] = useState<TextFontId>(INITIAL_PRESET.frontFontId);
  const [particleSize, setParticleSizeState] = useState(INITIAL_PRESET.particleSize);
  const [particleLimit, setParticleLimitState] = useState(INITIAL_PRESET.density);
  const [particleColor, setParticleColorState] = useState(INITIAL_PRESET.frontColor);
  const [lineWidth, setLineWidthState] = useState(INITIAL_PRESET.frontLineWidth);
  const [lineColor, setLineColorState] = useState(INITIAL_PRESET.frontLineColor);
  const [canvasRatio, setCanvasRatioState] = useState<CanvasRatio>("4:3");
  const [randomSeed, setRandomSeedState] = useState(0);
  const [toolMode, setToolModeState] = useState<ToolMode>("select");
  const [selectedGroupId, setSelectedGroupId] = useState<number | null>(null);
  const [selectedGroupType, setSelectedGroupType] = useState<ParticleType | null>(null);
  const [selectedGroupCount, setSelectedGroupCount] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [recordingClips, setRecordingClips] = useState<RecordingClip[]>([]);
  const [isHelpOpen, setIsHelpOpen] = useState(true);

  useEffect(() => {
    let disposed = false;

    async function bootSketch() {
      const P5 = (await import("p5")).default;
      if (disposed || !hostRef.current) return;

      const sketch = (p: P5Instance) => {
        let particles: Particle[] = [];
        let groups: ObjectGroup[] = [];
        let nextGroupId = 1;
        let drawingPath: Point[] = [];
        let isPointerDown = false;
        let isMovingSelection = false;
        let hasSelectionMoveSnapshot = false;
        let isBoxSelecting = false;
        let transformMode: TransformMode = "none";
        let activeTransformHandle: Point | null = null;
        let transformCenter: Point = { x: 0, y: 0 };
        let transformStartDistance = 1;
        let transformStartAngle = 0;
        let transformGroupSnapshots: ObjectGroup[] = [];
        let transformParticleSnapshots: Particle[] = [];
        let selectionBoxStart: Point | null = null;
        let selectionBoxEnd: Point | null = null;
        let pointerDownAt = 0;
        let pointerStart: Point = { x: 0, y: 0 };
        let previousPointer: Point = { x: 0, y: 0 };
        let pressurePoint: Point = { x: 0, y: 0 };
        let mode: ParticleState = "stable";
        let grainLayer: ReturnType<P5Instance["createImage"]>;
        let canvasElement: HTMLCanvasElement | null = null;
        let exportCanvasElement: HTMLCanvasElement | null = null;
        let exportCanvasContext: CanvasRenderingContext2D | null = null;
        let recordingFrameTimer: number | null = null;
        let h264Encoder: any = null;
        let mp4OnComplete: ((blob: Blob, extension: string) => void) | null = null;
        let recordingFrameIndex = 0;
        const recordingFps = 30;
        let undoStack: HistorySnapshot[] = [];

        p.setup = () => {
          const canvas = p.createCanvas(p.windowWidth, p.windowHeight);
          canvas.parent(hostRef.current as HTMLDivElement);
          canvasElement = canvas.elt as HTMLCanvasElement;
          p.pixelDensity(getDisplayPixelDensity());
          p.colorMode(p.RGB, 255, 255, 255, 255);
          p.noFill();
          grainLayer = makeGrainLayer();
          addInitialTextPreset();

          apiRef.current = {
            addTextParticles: (value: string, size: number) => {
              addTextParticles(value, p.width * 0.5, p.height * 0.5, size);
            },
            addImageParticles: (dataUrl: string) => {
              addImageParticles(dataUrl);
            },
            updateSelectedText: (value: string, size: number) => {
              return updateSelectedText(value, size);
            },
            updateSelectedTextContent: (value: string) => {
              const group = getSelectedGroup("text");
              if (!group || !group.size) return false;
              return updateSelectedText(value, group.size);
            },
            updateSelectedTextSize: (size: number) => {
              const selectedGroups = getSelectedGroups("text");
              if (selectedGroups.length === 0) return false;
              pushUndoSnapshot();
              for (const group of selectedGroups) {
                if (!group.text) continue;
                group.size = size;
                rebuildGroup(group);
              }
              return true;
            },
            updateSelectedLetterSpacing: (spacing: number) => {
              const selectedGroups = getSelectedGroups("text");
              if (selectedGroups.length === 0) return false;
              pushUndoSnapshot();
              for (const group of selectedGroups) {
                group.letterSpacing = spacing;
                rebuildGroup(group);
              }
              return true;
            },
            updateSelectedFont: (fontId: TextFontId) => {
              const selectedGroups = getSelectedGroups("text");
              if (selectedGroups.length === 0) return false;
              pushUndoSnapshot();
              for (const group of selectedGroups) {
                group.fontId = fontId;
                rebuildGroup(group);
              }
              return true;
            },
            updateSelectedParticleSize: (size: number) => {
              const selectedGroups = getSelectedGroups();
              if (selectedGroups.length === 0) return false;
              pushUndoSnapshot();
              selectedGroups.forEach((group) => {
                group.particleSize = size;
              });
              return true;
            },
            updateSelectedColor: (color: string) => {
              const selectedGroups = getSelectedGroups();
              if (selectedGroups.length === 0) return false;
              pushUndoSnapshot();
              selectedGroups.forEach((group) => {
                group.color = color;
              });
              return true;
            },
            updateSelectedLineWidth: (width: number) => {
              const selectedGroups = getSelectedGroups();
              if (selectedGroups.length === 0) return false;
              pushUndoSnapshot();
              selectedGroups.forEach((group) => {
                group.lineWidth = width;
              });
              return true;
            },
            updateSelectedLineColor: (color: string) => {
              const selectedGroups = getSelectedGroups();
              if (selectedGroups.length === 0) return false;
              pushUndoSnapshot();
              selectedGroups.forEach((group) => {
                group.lineColor = color;
              });
              return true;
            },
            updateSelectedRandomSeed: (seed: number) => {
              const selectedGroups = getSelectedGroups();
              if (selectedGroups.length === 0) return false;
              pushUndoSnapshot();
              selectedGroups.forEach((group) => {
                group.randomSeed = seed;
                rebuildGroup(group);
              });
              return true;
            },
            setParticleLimit: (limit: number) => {
              const selectedGroups = getSelectedGroups();
              if (selectedGroups.length === 0) return;
              pushUndoSnapshot();
              selectedGroups.forEach((group) => {
                group.density = limit;
                rebuildGroup(group);
              });
            },
            setCanvasRatio: (ratio: CanvasRatio) => {
              pushUndoSnapshot();
              const previousRect = getArtboardRect();
              canvasRatioRef.current = ratio;
              transformArtworkBetweenArtboards(previousRect, getArtboardRect());
            },
            exportPng: () => {
              return exportCanvasImage()?.toDataURL("image/png") ?? null;
            },
            exportSvg: () => {
              return buildSvgExport();
            },
            startRecording: async (onComplete: (blob: Blob, extension: string) => void) => {
              if (!canvasElement || h264Encoder) return false;
              const exportCanvas = exportCanvasImage();
              if (!exportCanvas) return false;
              exportCanvasElement = exportCanvas;
              exportCanvasContext = exportCanvasElement.getContext("2d");
              if (!exportCanvasContext) return false;

              try {
                const HME = await loadH264Encoder();
                const encoder = await HME.createH264MP4Encoder();
                encoder.width = Math.max(2, Math.floor(exportCanvasElement.width / 2) * 2);
                encoder.height = Math.max(2, Math.floor(exportCanvasElement.height / 2) * 2);
                encoder.frameRate = recordingFps;
                encoder.kbps = 8000;
                encoder.speed = 7;
                encoder.groupOfPictures = recordingFps * 2;
                encoder.initialize();
                if (encoder.width !== exportCanvasElement.width || encoder.height !== exportCanvasElement.height) {
                  exportCanvasElement.width = encoder.width;
                  exportCanvasElement.height = encoder.height;
                  exportCanvasContext = exportCanvasElement.getContext("2d");
                  if (!exportCanvasContext) {
                    encoder.delete();
                    return false;
                  }
                }
                h264Encoder = encoder;
                mp4OnComplete = onComplete;
              } catch (error) {
                console.error(error);
                h264Encoder = null;
                mp4OnComplete = null;
                exportCanvasElement = null;
                exportCanvasContext = null;
                return false;
              }

              recordingFrameIndex = 0;
              recordingFrameTimer = window.setInterval(() => {
                copyArtboardToCanvas(exportCanvasElement, exportCanvasContext);
                encodeMp4Frame();
              }, 1000 / 30);
              copyArtboardToCanvas(exportCanvasElement, exportCanvasContext);
              encodeMp4Frame();
              return true;
            },
            stopRecording: () => {
              void finishMp4Recording();
            },
            deleteSelectedGroup: () => {
              return deleteSelectedGroup();
            },
            clearParticles: () => {
              if (particles.length > 0 || groups.length > 0) pushUndoSnapshot();
              particles = [];
              groups = [];
              drawingPath = [];
              clearSelectedGroup();
            },
            undo: () => undoLastAction(),
          };
        };

        p.draw = () => {
          drawAtmosphere();
          drawArtboard();
          updateDrawing();
          updateParticles();
          beginArtboardClip();
          drawParticles();
          drawCurrentPath();
          endArtboardClip();
          drawSelectionBox();
          drawMarqueeBox();
        };

        p.windowResized = () => {
          const previousRect = getArtboardRect();
          p.pixelDensity(getDisplayPixelDensity());
          p.resizeCanvas(p.windowWidth, p.windowHeight);
          transformArtworkBetweenArtboards(previousRect, getArtboardRect());
          grainLayer = makeGrainLayer();
        };

        p.mousePressed = (event?: MouseEvent) => {
          if (!isCanvasPointerEvent(event) || !isInsideCanvas()) return;
          isPointerDown = true;
          pointerDownAt = p.millis();
          pointerStart = { x: p.mouseX, y: p.mouseY };
          previousPointer = { x: p.mouseX, y: p.mouseY };
          pressurePoint = { x: p.mouseX, y: p.mouseY };
          drawingPath = toolModeRef.current === "draw" ? [pointerStart] : [];
          mode = toolModeRef.current === "attract" ? "disturbed" : "stable";
          isMovingSelection = false;
          hasSelectionMoveSnapshot = false;
          isBoxSelecting = false;
          transformMode = "none";

          if (toolModeRef.current === "select") {
            const transformHandle = findTransformHandle(p.mouseX, p.mouseY);
            if (transformHandle) {
              beginSelectionTransform(transformHandle.kind, transformHandle.point);
              return;
            }

            const selectedId = findGroupAt(p.mouseX, p.mouseY);
            if (selectedId !== null) {
              if (!selectedGroupIdsRef.current.includes(selectedId)) {
                selectGroup(selectedId);
              }
              isMovingSelection = true;
            } else {
              clearSelectedGroup();
              isBoxSelecting = true;
              selectionBoxStart = { x: p.mouseX, y: p.mouseY };
              selectionBoxEnd = { x: p.mouseX, y: p.mouseY };
            }
          }
        };

        p.mouseDragged = () => {
          if (!isPointerDown || !isInsideCanvas()) return;
          pressurePoint = { x: p.mouseX, y: p.mouseY };
          if (toolModeRef.current === "select" && isBoxSelecting) {
            selectionBoxEnd = { x: p.mouseX, y: p.mouseY };
            return;
          }
          if (toolModeRef.current === "select" && transformMode !== "none") {
            updateSelectionTransform();
            return;
          }
          if (toolModeRef.current === "select" && isMovingSelection) {
            moveSelectedGroup(p.mouseX - previousPointer.x, p.mouseY - previousPointer.y);
            previousPointer = { x: p.mouseX, y: p.mouseY };
            return;
          }
          if (toolModeRef.current !== "draw") return;
          const last = drawingPath[drawingPath.length - 1];
          if (p.dist(last.x, last.y, p.mouseX, p.mouseY) >= 2.5) {
            drawingPath.push({ x: p.mouseX, y: p.mouseY });
          }
        };

        p.mouseReleased = () => {
          if (!isPointerDown) return;
          if (toolModeRef.current === "select" && isBoxSelecting) {
            const dragDistance = p.dist(pointerStart.x, pointerStart.y, p.mouseX, p.mouseY);
            if (dragDistance > CONFIG.mouseDriftLimit) {
              selectGroupsInBox(selectionBoxStart, selectionBoxEnd);
            }
            isBoxSelecting = false;
            selectionBoxStart = null;
            selectionBoxEnd = null;
          }
          isPointerDown = false;
          isMovingSelection = false;
          hasSelectionMoveSnapshot = false;
          if (transformMode !== "none") {
            transformMode = "none";
            activeTransformHandle = null;
          }
          if (toolModeRef.current === "draw") {
            const dragDistance = p.dist(pointerStart.x, pointerStart.y, p.mouseX, p.mouseY);
            if (drawingPath.length > 2 && dragDistance > CONFIG.mouseDriftLimit) {
              sampleDrawingPath(drawingPath);
            }
          }
          drawingPath = [];
          mode = "returning";
          for (const particle of particles) particle.state = "returning";
        };

        function drawAtmosphere() {
          p.blendMode(p.BLEND);
          p.background(235, 235, 230, CONFIG.trailAlpha);
        }

        function getDisplayPixelDensity() {
          return Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        }

        function getArtboardRect(): Rect {
          const ratio = CANVAS_RATIOS[canvasRatioRef.current];
          const panelClearance = p.width > 720 ? 360 : 24;
          const availableX = panelClearance;
          const availableWidth = Math.max(240, p.width - availableX - 40);
          const availableHeight = Math.max(240, p.height - 96);
          let width = availableWidth * 0.86;
          let height = width / ratio;

          if (height > availableHeight) {
            height = availableHeight;
            width = height * ratio;
          }

          return {
            x: availableX + (availableWidth - width) / 2,
            y: (p.height - height) / 2,
            width,
            height,
          };
        }

        function drawArtboard() {
          const rect = getArtboardRect();
          p.push();
          p.blendMode(p.BLEND);
          p.noStroke();
          p.fill(248, 248, 244);
          p.rect(rect.x, rect.y, rect.width, rect.height);
          p.pop();
        }

        function beginArtboardClip() {
          const rect = getArtboardRect();
          const context = p.drawingContext as CanvasRenderingContext2D;
          context.save();
          context.beginPath();
          context.rect(rect.x, rect.y, rect.width, rect.height);
          context.clip();
        }

        function endArtboardClip() {
          const context = p.drawingContext as CanvasRenderingContext2D;
          context.restore();
        }

        function transformArtworkBetweenArtboards(previousRect: Rect, nextRect: Rect) {
          if (
            previousRect.width <= 0 ||
            previousRect.height <= 0 ||
            nextRect.width <= 0 ||
            nextRect.height <= 0
          ) {
            return;
          }

          const scaleX = nextRect.width / previousRect.width;
          const scaleY = nextRect.height / previousRect.height;
          const uniformScale = Math.sqrt(scaleX * scaleY);

          for (const group of groups) {
            const transformedCenter = mapPointToArtboard(group.x, group.y, previousRect, nextRect);
            group.x = transformedCenter.x;
            group.y = transformedCenter.y;
            if (typeof group.size === "number") group.size = Math.max(1, group.size * uniformScale);
            if (typeof group.imageWidth === "number") group.imageWidth = Math.max(1, group.imageWidth * scaleX);
            if (typeof group.imageHeight === "number") group.imageHeight = Math.max(1, group.imageHeight * scaleY);
            if (group.path) {
              group.path = group.path.map((point) => mapPointToArtboard(point.x, point.y, previousRect, nextRect));
            }
          }

          for (const particle of particles) {
            const transformedHome = mapPointToArtboard(particle.homeX, particle.homeY, previousRect, nextRect);
            const transformedCurrent = mapPointToArtboard(particle.x, particle.y, previousRect, nextRect);
            particle.homeX = transformedHome.x;
            particle.homeY = transformedHome.y;
            particle.x = transformedCurrent.x;
            particle.y = transformedCurrent.y;
            particle.vx *= scaleX;
            particle.vy *= scaleY;
          }
        }

        function mapPointToArtboard(x: number, y: number, previousRect: Rect, nextRect: Rect) {
          return {
            x: nextRect.x + ((x - previousRect.x) / previousRect.width) * nextRect.width,
            y: nextRect.y + ((y - previousRect.y) / previousRect.height) * nextRect.height,
          };
        }

        function encodeMp4Frame() {
          if (!h264Encoder || !exportCanvasElement || !exportCanvasContext) return;
          const frame = exportCanvasContext.getImageData(0, 0, exportCanvasElement.width, exportCanvasElement.height);
          h264Encoder.addFrameRgba(frame.data);
          recordingFrameIndex += 1;
        }

        async function finishMp4Recording() {
          const encoder = h264Encoder;
          if (!encoder) return;
          if (recordingFrameTimer !== null) {
            window.clearInterval(recordingFrameTimer);
            recordingFrameTimer = null;
          }

          try {
            copyArtboardToCanvas(exportCanvasElement, exportCanvasContext);
            encodeMp4Frame();
            encoder.finalize();
            const bytes = encoder.FS.readFile(encoder.outputFilename) as Uint8Array;
            if (bytes.byteLength > 0 && mp4OnComplete) {
              const output = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
              mp4OnComplete(new Blob([output], { type: "video/mp4" }), "mp4");
            }
          } finally {
            encoder.delete();
            h264Encoder = null;
            mp4OnComplete = null;
            exportCanvasElement = null;
            exportCanvasContext = null;
          }
        }

        function addTextParticles(value: string, centerX: number, centerY: number, size: number, selectAfter = true) {
          const textValue = value.trim();
          if (!textValue) return;
          pushUndoSnapshot();
          const groupId = nextGroupId;
          nextGroupId += 1;
          groups.push({
            id: groupId,
            type: "text",
            text: textValue,
            x: centerX,
            y: centerY,
            size,
            particleSize: particleSizeRef.current,
            color: particleColorRef.current,
            lineWidth: lineWidthRef.current,
            lineColor: lineColorRef.current,
            randomSeed: 0,
            density: particleLimitRef.current,
            letterSpacing: letterSpacingRef.current,
            fontId: textFontRef.current,
          });
          particles = [
            ...particles,
            ...buildTextParticles(
              textValue,
              centerX,
              centerY,
              size,
              groupId,
              particleLimitRef.current,
              0,
              0,
              letterSpacingRef.current,
              textFontRef.current,
            ),
          ];
          if (selectAfter) selectGroup(groupId);
        }

        function addInitialTextPreset() {
          const centerX = p.width * 0.6;
          const centerY = p.height * 0.497;
          addStyledTextParticles({
            value: INITIAL_KOREAN_TEXT,
            centerX,
            centerY,
            size: INITIAL_PRESET.size,
            letterSpacing: INITIAL_PRESET.backLetterSpacing,
            fontId: INITIAL_PRESET.backFontId,
            particleSize: INITIAL_PRESET.particleSize,
            density: INITIAL_PRESET.density,
            color: INITIAL_PRESET.backColor,
            lineWidth: INITIAL_PRESET.backLineWidth,
            lineColor: INITIAL_PRESET.backLineColor,
            randomSeed: 0,
          });
          addStyledTextParticles({
            value: INITIAL_TEXT,
            centerX: centerX + 2,
            centerY: centerY + 56,
            size: INITIAL_PRESET.size,
            letterSpacing: INITIAL_PRESET.frontLetterSpacing,
            fontId: INITIAL_PRESET.frontFontId,
            particleSize: INITIAL_PRESET.particleSize,
            density: INITIAL_PRESET.density,
            color: INITIAL_PRESET.frontColor,
            lineWidth: INITIAL_PRESET.frontLineWidth,
            lineColor: INITIAL_PRESET.frontLineColor,
            randomSeed: 0,
          });
        }

        function addStyledTextParticles({
          value,
          centerX,
          centerY,
          size,
          letterSpacing,
          fontId,
          particleSize,
          density,
          color,
          lineWidth,
          lineColor,
          randomSeed,
        }: {
          value: string;
          centerX: number;
          centerY: number;
          size: number;
          letterSpacing: number;
          fontId: TextFontId;
          particleSize: number;
          density: number;
          color: string;
          lineWidth: number;
          lineColor: string;
          randomSeed: number;
        }) {
          const groupId = nextGroupId;
          nextGroupId += 1;
          groups.push({
            id: groupId,
            type: "text",
            text: value,
            x: centerX,
            y: centerY,
            size,
            particleSize,
            color,
            lineWidth,
            lineColor,
            randomSeed,
            density,
            letterSpacing,
            fontId,
          });
          particles = [
            ...particles,
            ...buildTextParticles(
              value,
              centerX,
              centerY,
              size,
              groupId,
              density,
              randomSeed,
              0,
              letterSpacing,
              fontId,
            ),
          ];
        }

        function addImageParticles(dataUrl: string) {
          const image = new Image();
          image.onload = () => {
            pushUndoSnapshot();
            const groupId = nextGroupId;
            nextGroupId += 1;
            const maxDisplaySize = Math.min(p.width, p.height) * 0.62;
            const scale = Math.min(1, maxDisplaySize / Math.max(image.naturalWidth, image.naturalHeight));
            const imageWidth = image.naturalWidth * scale;
            const imageHeight = image.naturalHeight * scale;
            const centerX = p.width * 0.5;
            const centerY = p.height * 0.5;

            groups.push({
              id: groupId,
              type: "image",
              x: centerX,
              y: centerY,
              particleSize: particleSizeRef.current,
              color: particleColorRef.current,
              lineWidth: lineWidthRef.current,
              randomSeed: 0,
              density: particleLimitRef.current,
              imageDataUrl: dataUrl,
              imageElement: image,
              imageWidth,
              imageHeight,
            });
            particles = [
              ...particles,
              ...buildImageParticles(
                image,
                centerX,
                centerY,
                imageWidth,
                imageHeight,
                groupId,
                particleLimitRef.current,
                0,
                0,
              ),
            ];
            selectGroup(groupId);
          };
          image.src = dataUrl;
        }

        function buildTextParticles(
          value: string,
          centerX: number,
          centerY: number,
          size: number,
          groupId: number,
          density = particleLimitRef.current,
          randomSeed = 0,
          rotation = 0,
          letterSpacing = 0,
          fontId: TextFontId = INITIAL_PRESET.frontFontId,
        ) {
          const buffer = document.createElement("canvas");
          buffer.width = Math.max(420, p.width, Math.ceil(value.length * (size + Math.abs(letterSpacing)) + size * 2));
          buffer.height = Math.max(220, Math.floor(size * 1.9));
          const context = buffer.getContext("2d", { willReadFrequently: true });
          if (!context) return [];

          context.clearRect(0, 0, buffer.width, buffer.height);
          context.fillStyle = "#fff";
          context.textAlign = "left";
          context.textBaseline = "middle";
          context.font = `700 ${size}px ${getTextFontStack(fontId)}`;
          drawTextWithLetterSpacing(context, value, buffer.width / 2, buffer.height / 2, letterSpacing);
          const pixels = context.getImageData(0, 0, buffer.width, buffer.height).data;

          const next: Particle[] = [];
          const xOffset = centerX - buffer.width / 2;
          const yOffset = centerY - buffer.height / 2;
          const sampleStep = getTextSampleStep(density);
          const noiseThreshold = getTextNoiseThreshold(density);

          for (let y = 0; y < buffer.height; y += sampleStep) {
            for (let x = 0; x < buffer.width; x += sampleStep) {
              const index = 4 * (y * buffer.width + x) + 3;
              if (pixels[index] > 80 && p.noise(x * 0.05 + randomSeed * 0.017, y * 0.05 - randomSeed * 0.011) > noiseThreshold) {
                const rotated = rotateAroundCenter(x + xOffset, y + yOffset, centerX, centerY, rotation);
                next.push(makeParticle(rotated.x, rotated.y, "text", groupId));
              }
            }
          }

          return normalizeParticleCount(next, density);
        }

        function drawTextWithLetterSpacing(
          context: CanvasRenderingContext2D,
          value: string,
          centerX: number,
          centerY: number,
          spacing: number,
        ) {
          const characters = Array.from(value);
          const widths = characters.map((character) => context.measureText(character).width);
          const totalWidth = widths.reduce((sum, width) => sum + width, 0) + spacing * Math.max(0, characters.length - 1);
          let cursorX = centerX - totalWidth / 2;

          characters.forEach((character, index) => {
            context.fillText(character, cursorX, centerY);
            cursorX += widths[index] + spacing;
          });
        }

        function updateSelectedText(value: string, size: number) {
          const groupId = selectedGroupIdRef.current;
          const textValue = value.trim();
          if (!groupId || !textValue) return false;

          const group = groups.find((item) => item.id === groupId && item.type === "text");
          if (!group) return false;

          pushUndoSnapshot();
          group.text = textValue;
          group.size = size;
          rebuildTextGroup(group);
          selectGroup(groupId);
          return true;
        }

        function sampleDrawingPath(path: Point[]) {
          if (path.length < 2) return;
          pushUndoSnapshot();
          const groupId = nextGroupId;
          nextGroupId += 1;
          groups.push({
            id: groupId,
            type: "drawing",
            x: path.reduce((sum, point) => sum + point.x, 0) / path.length,
            y: path.reduce((sum, point) => sum + point.y, 0) / path.length,
            particleSize: particleSizeRef.current,
            color: particleColorRef.current,
            lineWidth: lineWidthRef.current,
            lineColor: lineColorRef.current,
            randomSeed: 0,
            density: particleLimitRef.current,
            path: path.map((point) => ({ ...point })),
          });
          particles = [...particles, ...buildDrawingParticles(path, groupId, particleLimitRef.current, 0)];
          selectGroup(groupId);
        }

        function buildDrawingParticles(path: Point[], groupId: number, density = particleLimitRef.current, randomSeed = 0) {
          const sampled: Particle[] = [];
          const sampleDistance = getDrawingSampleDistance(density);
          let carry = (randomSeed % 100) / 100 * sampleDistance;

          for (let i = 1; i < path.length; i += 1) {
            const a = path[i - 1];
            const b = path[i];
            const segmentLength = p.dist(a.x, a.y, b.x, b.y);
            if (segmentLength < 0.01) continue;

            for (let d = carry; d < segmentLength; d += sampleDistance) {
              const t = d / segmentLength;
              sampled.push(makeParticle(p.lerp(a.x, b.x, t), p.lerp(a.y, b.y, t), "drawing", groupId));
            }
            carry = (carry + segmentLength) % sampleDistance;
          }

          return normalizeParticleCount(sampled, density);
        }

        function buildImageParticles(
          image: HTMLImageElement,
          centerX: number,
          centerY: number,
          width: number,
          height: number,
          groupId: number,
          density = particleLimitRef.current,
          randomSeed = 0,
          rotation = 0,
        ) {
          const buffer = document.createElement("canvas");
          buffer.width = Math.max(1, Math.round(width));
          buffer.height = Math.max(1, Math.round(height));
          const context = buffer.getContext("2d", { willReadFrequently: true });
          if (!context) return [];
          context.drawImage(image, 0, 0, buffer.width, buffer.height);
          const pixels = context.getImageData(0, 0, buffer.width, buffer.height).data;
          const next: Particle[] = [];
          const step = getImageSampleStep(density);
          const xOffset = centerX - buffer.width / 2;
          const yOffset = centerY - buffer.height / 2;

          for (let y = 0; y < buffer.height; y += step) {
            for (let x = 0; x < buffer.width; x += step) {
              const index = 4 * (y * buffer.width + x);
              const alpha = pixels[index + 3];
              if (alpha < 32) continue;

              const red = pixels[index];
              const green = pixels[index + 1];
              const blue = pixels[index + 2];
              const brightness = (red + green + blue) / 3;
              if (brightness > 246 && alpha > 245) continue;

              const jitter = step * 0.32;
              const jitterX = (p.noise(x * 0.07 + randomSeed * 0.031, y * 0.07) - 0.5) * jitter * 2;
              const jitterY = (p.noise(x * 0.07, y * 0.07 - randomSeed * 0.029) - 0.5) * jitter * 2;
              const rotated = rotateAroundCenter(x + xOffset + jitterX, y + yOffset + jitterY, centerX, centerY, rotation);
              next.push(makeParticle(rotated.x, rotated.y, "image", groupId, [red, green, blue]));
            }
          }

          return normalizeParticleCount(next, density);
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
          }

          if (isAttracting && mode === "attracted") {
            applyParticleCollisions(mouse.x, mouse.y);
          }
          applyInterGroupCollisions();

          for (const particle of particles) {
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
            const fillColor = getParticleFillColor(particle);
            const strokeColor = getParticleStrokeColor(particle);
            const speed = Math.min(1, p.dist(0, 0, particle.vx, particle.vy) / 9);
            const isSelected = Boolean(particle.groupId && selectedGroupIdsRef.current.includes(particle.groupId));
            const alpha = isSelected ? 255 : 225 + speed * 20;

            const group = getGroupForParticle(particle);
            const groupParticleSize = group?.particleSize ?? particleSizeRef.current;
            const groupLineWidth = group?.lineWidth ?? lineWidthRef.current;
            const diameter = Math.max(1, particle.size * groupParticleSize * (isSelected ? 1.18 : 1));
            p.strokeWeight(groupLineWidth);
            p.stroke(strokeColor[0], strokeColor[1], strokeColor[2], alpha);
            p.fill(fillColor[0], fillColor[1], fillColor[2], alpha);
            p.circle(particle.x, particle.y, diameter);

          }

          p.blendMode(p.BLEND);
        }

        function buildSvgExport() {
          const rect = getArtboardRect();
          const circles = particles
            .filter((particle) => isInsideRect(particle.x, particle.y, rect))
            .map((particle, index) => {
              const fillColor = getParticleFillColor(particle);
              const strokeColor = getParticleStrokeColor(particle);
              const group = getGroupForParticle(particle);
              const groupParticleSize = group?.particleSize ?? particleSizeRef.current;
              const groupLineWidth = group?.lineWidth ?? lineWidthRef.current;
              const radius = Math.max(0.5, (particle.size * groupParticleSize) / 2);
              return `<circle cx="${roundSvg(particle.x - rect.x)}" cy="${roundSvg(particle.y - rect.y)}" r="${roundSvg(radius)}" fill="${rgbToSvg(fillColor)}" stroke="${rgbToSvg(strokeColor)}" stroke-width="${roundSvg(groupLineWidth)}" />`;
            })
            .join("\n  ");
          const width = Math.round(rect.width);
          const height = Math.round(rect.height);

          return [
            `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
            `  <rect width="100%" height="100%" fill="#f8f8f4" />`,
            `  ${circles}`,
            `</svg>`,
          ].join("\n");
        }

        function isInsideRect(x: number, y: number, rect: Rect) {
          return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
        }

        function exportCanvasImage() {
          const rect = getArtboardRect();
          const exportCanvas = document.createElement("canvas");
          exportCanvas.width = Math.max(1, Math.round(rect.width));
          exportCanvas.height = Math.max(1, Math.round(rect.height));
          const context = exportCanvas.getContext("2d");
          if (!context) return null;
          copyArtboardToCanvas(exportCanvas, context);
          return exportCanvas;
        }

        function copyArtboardToCanvas(
          targetCanvas: HTMLCanvasElement | null,
          context: CanvasRenderingContext2D | null,
        ) {
          if (!canvasElement || !targetCanvas || !context) return;
          const rect = getArtboardRect();
          const width = Math.max(1, Math.round(rect.width));
          const height = Math.max(1, Math.round(rect.height));
          if (targetCanvas.width !== width) targetCanvas.width = width;
          if (targetCanvas.height !== height) targetCanvas.height = height;
          drawArtboardContentToContext(context, rect, width, height);
        }

        function drawArtboardContentToContext(context: CanvasRenderingContext2D, rect: Rect, width: number, height: number) {
          const scaleX = width / rect.width;
          const scaleY = height / rect.height;
          context.save();
          context.fillStyle = "#f8f8f4";
          context.fillRect(0, 0, width, height);
          context.scale(scaleX, scaleY);
          context.translate(-rect.x, -rect.y);

          for (const particle of particles) {
            if (!isInsideRect(particle.x, particle.y, rect)) continue;
            const fillColor = getParticleFillColor(particle);
            const strokeColor = getParticleStrokeColor(particle);
            const group = getGroupForParticle(particle);
            const groupParticleSize = group?.particleSize ?? particleSizeRef.current;
            const groupLineWidth = group?.lineWidth ?? lineWidthRef.current;
            const diameter = Math.max(1, particle.size * groupParticleSize);

            context.beginPath();
            context.lineWidth = groupLineWidth;
            context.strokeStyle = rgbToCanvasColor(strokeColor);
            context.fillStyle = rgbToCanvasColor(fillColor);
            context.arc(particle.x, particle.y, diameter / 2, 0, Math.PI * 2);
            context.fill();
            if (groupLineWidth > 0) context.stroke();
          }

          context.restore();
        }

        function roundSvg(value: number) {
          return Number.isFinite(value) ? value.toFixed(2).replace(/\.?0+$/, "") : "0";
        }

        function rgbToSvg(rgb: number[]) {
          return `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})`;
        }

        function rgbToCanvasColor(rgb: number[]) {
          return `rgb(${Math.round(rgb[0])}, ${Math.round(rgb[1])}, ${Math.round(rgb[2])})`;
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

        function drawSelectionBox() {
          const bounds = getSelectedBounds();
          if (!bounds) return;

          const box = getSelectionBox(bounds);
          const { x, y, width, height } = box;

          p.blendMode(p.BLEND);
          p.noFill();
          p.stroke(26, 86, 168, 230);
          p.strokeWeight(1.4);
          const context = p.drawingContext as CanvasRenderingContext2D;
          context.setLineDash([6, 5]);
          p.rect(x, y, width, height);
          context.setLineDash([]);

          p.noStroke();
          p.fill(26, 86, 168, 230);
          const handles = getSelectionHandles(box);
          const handleSize = 8;
          for (const handle of handles.scale) {
            p.rect(handle.x - handleSize / 2, handle.y - handleSize / 2, handleSize, handleSize);
          }

          p.stroke(26, 86, 168, 190);
          p.strokeWeight(1);
          p.line(handles.rotateAnchor.x, handles.rotateAnchor.y, handles.rotate.x, handles.rotate.y);
          p.noStroke();
          p.circle(handles.rotate.x, handles.rotate.y, handleSize + 2);
        }

        function drawMarqueeBox() {
          if (!isBoxSelecting || !selectionBoxStart || !selectionBoxEnd) return;
          const x = Math.min(selectionBoxStart.x, selectionBoxEnd.x);
          const y = Math.min(selectionBoxStart.y, selectionBoxEnd.y);
          const width = Math.abs(selectionBoxEnd.x - selectionBoxStart.x);
          const height = Math.abs(selectionBoxEnd.y - selectionBoxStart.y);
          if (width < 2 && height < 2) return;

          p.blendMode(p.BLEND);
          p.noFill();
          p.stroke(26, 86, 168, 190);
          p.strokeWeight(1);
          const context = p.drawingContext as CanvasRenderingContext2D;
          context.setLineDash([4, 4]);
          p.rect(x, y, width, height);
          context.setLineDash([]);
        }

        function getSelectionBox(bounds: { minX: number; minY: number; maxX: number; maxY: number }) {
          const padding = Math.max(10, particleSizeRef.current * 2);
          return {
            x: bounds.minX - padding,
            y: bounds.minY - padding,
            width: bounds.maxX - bounds.minX + padding * 2,
            height: bounds.maxY - bounds.minY + padding * 2,
          };
        }

        function getSelectionHandles(box: { x: number; y: number; width: number; height: number }) {
          const centerX = box.x + box.width / 2;
          const rotateY = box.y - 30;
          return {
            scale: [
              { x: box.x, y: box.y },
              { x: box.x + box.width, y: box.y },
              { x: box.x, y: box.y + box.height },
              { x: box.x + box.width, y: box.y + box.height },
            ],
            rotateAnchor: { x: centerX, y: box.y },
            rotate: { x: centerX, y: rotateY },
          };
        }

        function findTransformHandle(x: number, y: number) {
          const bounds = getSelectedBounds();
          if (!bounds) return null;
          const box = getSelectionBox(bounds);
          const handles = getSelectionHandles(box);
          const hitRadius = 13;

          if (p.dist(x, y, handles.rotate.x, handles.rotate.y) <= hitRadius) {
            return { kind: "rotate" as TransformMode, point: handles.rotate };
          }

          const scaleHandle = handles.scale.find((handle) => p.dist(x, y, handle.x, handle.y) <= hitRadius);
          if (scaleHandle) return { kind: "scale" as TransformMode, point: scaleHandle };
          return null;
        }

        function applyAttraction(particle: Particle, mouseX: number, mouseY: number, amount: number) {
          const dx = mouseX - particle.x;
          const dy = mouseY - particle.y;
          const distance = Math.sqrt(dx * dx + dy * dy) || 0.001;
          const nx = dx / distance;
          const ny = dy / distance;
          const direction = particle.seed % 2 > 1 ? -1 : 1;
          const tangentX = -ny * direction;
          const tangentY = nx * direction;
          const pull = CONFIG.attractionStrength * (0.18 + amount * amount);
          const closeAmount = 1 - smoothstep(0, 150, distance);
          const swirlNoise = p.noise(particle.seed, p.frameCount * 0.018) - 0.5;
          const orbit = CONFIG.orbitStrength * amount * (0.25 + closeAmount * 0.75 + swirlNoise * 0.2);

          particle.vx += dx * pull;
          particle.vy += dy * pull;
          particle.vx += tangentX * orbit;
          particle.vy += tangentY * orbit;
        }

        function applyParticleCollisions(centerX: number, centerY: number) {
          const activeParticles = particles.filter(
            (particle) => p.dist(centerX, centerY, particle.x, particle.y) < CONFIG.interactionRadius,
          );
          if (activeParticles.length < 2) return;

          const collisionParticles = activeParticles.slice(-CONFIG.collisionMaxChecks);
          const grid = new Map<string, Particle[]>();
          const cellSize = CONFIG.collisionCellSize;

          for (const particle of collisionParticles) {
            const cellX = Math.floor(particle.x / cellSize);
            const cellY = Math.floor(particle.y / cellSize);
            const key = `${cellX},${cellY}`;
            const cell = grid.get(key);
            if (cell) {
              cell.push(particle);
            } else {
              grid.set(key, [particle]);
            }
          }

          for (const particle of collisionParticles) {
            const cellX = Math.floor(particle.x / cellSize);
            const cellY = Math.floor(particle.y / cellSize);
            for (let y = cellY - 1; y <= cellY + 1; y += 1) {
              for (let x = cellX - 1; x <= cellX + 1; x += 1) {
                const cell = grid.get(`${x},${y}`);
                if (!cell) continue;
                for (const other of cell) {
                  if (other === particle || other.seed < particle.seed) continue;
                  resolveParticleCollision(particle, other, CONFIG.collisionStrength);
                }
              }
            }
          }
        }

        function applyInterGroupCollisions() {
          if (particles.length < 2) return;

          const collisionParticles = particles.slice(-CONFIG.interGroupCollisionMaxChecks);
          const grid = new Map<string, Particle[]>();
          const cellSize = CONFIG.collisionCellSize;

          for (const particle of collisionParticles) {
            if (!particle.groupId) continue;
            const cellX = Math.floor(particle.x / cellSize);
            const cellY = Math.floor(particle.y / cellSize);
            const key = `${cellX},${cellY}`;
            const cell = grid.get(key);
            if (cell) {
              cell.push(particle);
            } else {
              grid.set(key, [particle]);
            }
          }

          for (const particle of collisionParticles) {
            if (!particle.groupId) continue;
            const cellX = Math.floor(particle.x / cellSize);
            const cellY = Math.floor(particle.y / cellSize);
            for (let y = cellY - 1; y <= cellY + 1; y += 1) {
              for (let x = cellX - 1; x <= cellX + 1; x += 1) {
                const cell = grid.get(`${x},${y}`);
                if (!cell) continue;
                for (const other of cell) {
                  if (other === particle || other.seed < particle.seed || other.groupId === particle.groupId) continue;
                  resolveParticleCollision(particle, other, CONFIG.interGroupCollisionStrength);
                }
              }
            }
          }
        }

        function resolveParticleCollision(a: Particle, b: Particle, strength: number) {
          const ax = a.x - b.x;
          const ay = a.y - b.y;
          const distanceSq = ax * ax + ay * ay;
          const minDistance = getParticleCollisionRadius(a) + getParticleCollisionRadius(b);
          if (distanceSq >= minDistance * minDistance) return;

          const distance = Math.sqrt(distanceSq) || 0.001;
          const nx = ax / distance;
          const ny = ay / distance;
          const overlap = (minDistance - distance) * strength;
          const push = overlap * 0.5;

          a.x += nx * push;
          a.y += ny * push;
          b.x -= nx * push;
          b.y -= ny * push;

          const relativeVx = a.vx - b.vx;
          const relativeVy = a.vy - b.vy;
          const separatingVelocity = relativeVx * nx + relativeVy * ny;
          if (separatingVelocity > 0) return;

          const impulse = -separatingVelocity * CONFIG.collisionBounce;
          a.vx += nx * impulse;
          a.vy += ny * impulse;
          b.vx -= nx * impulse;
          b.vy -= ny * impulse;
        }

        function getParticleCollisionRadius(particle: Particle) {
          const group = getGroupForParticle(particle);
          const groupParticleSize = group?.particleSize ?? particleSizeRef.current;
          return Math.max(2.8, particle.size * groupParticleSize * 0.58);
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

        function rotateAroundCenter(x: number, y: number, centerX: number, centerY: number, rotation: number) {
          if (rotation === 0) return { x, y };
          const dx = x - centerX;
          const dy = y - centerY;
          const cos = Math.cos(rotation);
          const sin = Math.sin(rotation);
          return {
            x: centerX + dx * cos - dy * sin,
            y: centerY + dx * sin + dy * cos,
          };
        }

        function smoothstep(edge0: number, edge1: number, x: number) {
          const t = p.constrain((x - edge0) / (edge1 - edge0), 0, 1);
          return t * t * (3 - 2 * t);
        }

        function makeParticle(x: number, y: number, type: ParticleType, groupId?: number, rgb?: number[]): Particle {
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
            rgb,
          };
        }

        function normalizeParticleCount(next: Particle[], limit: number) {
          if (next.length <= limit) return next;
          const normalized: Particle[] = [];
          const step = next.length / limit;
          for (let i = 0; i < limit; i += 1) {
            normalized.push(next[Math.floor(i * step)]);
          }
          return normalized;
        }

        function getDensityRatio(limit = particleLimitRef.current) {
          return p.constrain((limit - 500) / (12000 - 500), 0, 1);
        }

        function getTextSampleStep(limit = particleLimitRef.current) {
          return Math.max(3, Math.round(p.lerp(12, 4, getDensityRatio(limit))));
        }

        function getTextNoiseThreshold(limit = particleLimitRef.current) {
          return p.lerp(0.48, 0.08, getDensityRatio(limit));
        }

        function getDrawingSampleDistance(limit = particleLimitRef.current) {
          return p.lerp(18, 3, getDensityRatio(limit));
        }

        function getImageSampleStep(limit = particleLimitRef.current) {
          return Math.max(2, Math.round(p.lerp(14, 3, getDensityRatio(limit))));
        }

        function getParticleFillColor(particle: Particle) {
          const group = getGroupForParticle(particle);
          return particle.rgb ?? hexToRgb(group?.color ?? particleColorRef.current);
        }

        function getParticleStrokeColor(particle: Particle) {
          const group = getGroupForParticle(particle);
          return hexToRgb(group?.lineColor ?? lineColorRef.current);
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
          return isInsideRect(p.mouseX, p.mouseY, getArtboardRect());
        }

        function isCanvasPointerEvent(event?: MouseEvent) {
          return !event || event.target === canvasElement;
        }

        function findGroupAt(x: number, y: number) {
          let nearestGroupId: number | null = null;
          let nearestDistance = Infinity;
          const hitRadius = Math.max(20, particleSizeRef.current * 5);

          for (const particle of particles) {
            if (!particle.groupId) continue;
            const distance = p.dist(x, y, particle.x, particle.y);
            if (distance < hitRadius && distance < nearestDistance) {
              nearestDistance = distance;
              nearestGroupId = particle.groupId;
            }
          }

          return nearestGroupId;
        }

        function selectGroup(groupId: number) {
          selectGroups([groupId]);
        }

        function selectGroups(groupIds: number[]) {
          const uniqueIds = Array.from(new Set(groupIds)).filter((groupId) =>
            groups.some((group) => group.id === groupId),
          );
          if (uniqueIds.length === 0) {
            clearSelectedGroup();
            return;
          }

          const groupId = uniqueIds[uniqueIds.length - 1];
          const group = groups.find((item) => item.id === groupId);
          if (!group) return;
          selectedGroupIdsRef.current = uniqueIds;
          selectedGroupIdRef.current = groupId;
          setSelectedGroupId(groupId);
          setSelectedGroupType(group.type);
          setSelectedGroupCount(uniqueIds.length);
          if (group.type === "text" && group.text && group.size) {
            setText(group.text);
            setTextSize(group.size);
            setLetterSpacing(group.letterSpacing ?? 0);
            textFontRef.current = group.fontId ?? INITIAL_PRESET.frontFontId;
            setTextFontState(group.fontId ?? INITIAL_PRESET.frontFontId);
          }
          setParticleSize(group.particleSize);
          setParticleColor(group.color);
          lineWidthRef.current = group.lineWidth;
          setLineWidthState(group.lineWidth);
          lineColorRef.current = group.lineColor ?? group.color;
          setLineColorState(group.lineColor ?? group.color);
          randomSeedRef.current = group.randomSeed;
          setRandomSeedState(group.randomSeed);
          particleLimitRef.current = group.density;
          setParticleLimitState(group.density);
        }

        function selectGroupsInBox(start: Point | null, end: Point | null) {
          if (!start || !end) return;
          const minX = Math.min(start.x, end.x);
          const maxX = Math.max(start.x, end.x);
          const minY = Math.min(start.y, end.y);
          const maxY = Math.max(start.y, end.y);
          const selectedIds = groups
            .filter((group) => {
              const bounds = getGroupBounds(group.id);
              if (!bounds) return false;
              return bounds.maxX >= minX && bounds.minX <= maxX && bounds.maxY >= minY && bounds.minY <= maxY;
            })
            .map((group) => group.id);

          selectGroups(selectedIds);
        }

        function moveSelectedGroup(dx: number, dy: number) {
          const groupIds = selectedGroupIdsRef.current;
          if (groupIds.length === 0) return;
          if (!hasSelectionMoveSnapshot) {
            pushUndoSnapshot();
            hasSelectionMoveSnapshot = true;
          }

          for (const group of groups) {
            if (!groupIds.includes(group.id)) continue;
            group.x += dx;
            group.y += dy;
            if (group.path) {
              group.path = group.path.map((point) => ({ x: point.x + dx, y: point.y + dy }));
            }
          }

          for (const particle of particles) {
            if (!particle.groupId || !groupIds.includes(particle.groupId)) continue;
            particle.x += dx;
            particle.y += dy;
            particle.homeX += dx;
            particle.homeY += dy;
            particle.vx = 0;
            particle.vy = 0;
          }
        }

        function beginSelectionTransform(kind: TransformMode, handlePoint: Point) {
          const bounds = getSelectedBounds();
          const groupIds = selectedGroupIdsRef.current;
          if (!bounds || groupIds.length === 0) return;

          pushUndoSnapshot();
          transformMode = kind;
          activeTransformHandle = handlePoint;
          transformCenter = {
            x: (bounds.minX + bounds.maxX) / 2,
            y: (bounds.minY + bounds.maxY) / 2,
          };
          transformStartDistance = Math.max(8, p.dist(transformCenter.x, transformCenter.y, handlePoint.x, handlePoint.y));
          transformStartAngle = Math.atan2(handlePoint.y - transformCenter.y, handlePoint.x - transformCenter.x);
          transformGroupSnapshots = groups
            .filter((group) => groupIds.includes(group.id))
            .map((group) => cloneGroup(group));
          transformParticleSnapshots = particles
            .filter((particle) => particle.groupId && groupIds.includes(particle.groupId))
            .map((particle) => ({ ...particle }));
        }

        function updateSelectionTransform() {
          if (transformMode === "none") return;
          const distance = Math.max(1, p.dist(transformCenter.x, transformCenter.y, p.mouseX, p.mouseY));
          const currentAngle = Math.atan2(p.mouseY - transformCenter.y, p.mouseX - transformCenter.x);
          const scale = transformMode === "scale" ? p.constrain(distance / transformStartDistance, 0.08, 12) : 1;
          const rotation = transformMode === "rotate" ? currentAngle - transformStartAngle : 0;

          applyTransformToGroups(scale, rotation);
          applyTransformToParticles(scale, rotation);
        }

        function applyTransformToGroups(scale: number, rotation: number) {
          for (const snapshot of transformGroupSnapshots) {
            const group = groups.find((item) => item.id === snapshot.id);
            if (!group) continue;
            const transformedCenter = transformPoint(snapshot.x, snapshot.y, scale, rotation);
            group.x = transformedCenter.x;
            group.y = transformedCenter.y;
            group.rotation = (snapshot.rotation ?? 0) + rotation;

            if (typeof snapshot.size === "number") group.size = Math.max(1, snapshot.size * scale);
            if (typeof snapshot.imageWidth === "number") group.imageWidth = Math.max(1, snapshot.imageWidth * scale);
            if (typeof snapshot.imageHeight === "number") group.imageHeight = Math.max(1, snapshot.imageHeight * scale);
            if (snapshot.path) {
              group.path = snapshot.path.map((point) => transformPoint(point.x, point.y, scale, rotation));
            }
          }
        }

        function applyTransformToParticles(scale: number, rotation: number) {
          for (const snapshot of transformParticleSnapshots) {
            const particle = particles.find((item) => item.groupId === snapshot.groupId && item.seed === snapshot.seed);
            if (!particle) continue;
            const transformedHome = transformPoint(snapshot.homeX, snapshot.homeY, scale, rotation);
            const transformedCurrent = transformPoint(snapshot.x, snapshot.y, scale, rotation);
            particle.homeX = transformedHome.x;
            particle.homeY = transformedHome.y;
            particle.x = transformedCurrent.x;
            particle.y = transformedCurrent.y;
            particle.vx = 0;
            particle.vy = 0;
          }
        }

        function transformPoint(x: number, y: number, scale: number, rotation: number) {
          const dx = (x - transformCenter.x) * scale;
          const dy = (y - transformCenter.y) * scale;
          const cos = Math.cos(rotation);
          const sin = Math.sin(rotation);
          return {
            x: transformCenter.x + dx * cos - dy * sin,
            y: transformCenter.y + dx * sin + dy * cos,
          };
        }

        function cloneGroup(group: ObjectGroup): ObjectGroup {
          return {
            ...group,
            path: group.path?.map((point) => ({ ...point })),
          };
        }

        function cloneParticle(particle: Particle): Particle {
          return {
            ...particle,
            rgb: particle.rgb ? [...particle.rgb] : undefined,
          };
        }

        function createHistorySnapshot(): HistorySnapshot {
          return {
            groups: groups.map((group) => cloneGroup(group)),
            particles: particles.map((particle) => cloneParticle(particle)),
            nextGroupId,
            selectedGroupIds: [...selectedGroupIdsRef.current],
            selectedGroupId: selectedGroupIdRef.current,
            canvasRatio: canvasRatioRef.current,
          };
        }

        function pushUndoSnapshot() {
          undoStack.push(createHistorySnapshot());
          if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
        }

        function undoLastAction() {
          const snapshot = undoStack.pop();
          if (!snapshot) return false;

          groups = snapshot.groups.map((group) => cloneGroup(group));
          particles = snapshot.particles.map((particle) => cloneParticle(particle));
          nextGroupId = snapshot.nextGroupId;
          canvasRatioRef.current = snapshot.canvasRatio;
          setCanvasRatioState(snapshot.canvasRatio);
          drawingPath = [];
          isPointerDown = false;
          isMovingSelection = false;
          hasSelectionMoveSnapshot = false;
          isBoxSelecting = false;
          transformMode = "none";
          activeTransformHandle = null;
          selectionBoxStart = null;
          selectionBoxEnd = null;
          mode = "returning";

          const validIds = snapshot.selectedGroupIds.filter((id) => groups.some((group) => group.id === id));
          if (validIds.length > 0) {
            selectGroups(validIds);
          } else if (snapshot.selectedGroupId && groups.some((group) => group.id === snapshot.selectedGroupId)) {
            selectGroup(snapshot.selectedGroupId);
          } else {
            clearSelectedGroup();
          }

          for (const particle of particles) particle.state = "returning";
          return true;
        }

        function clearSelectedGroup() {
          selectedGroupIdsRef.current = [];
          selectedGroupIdRef.current = null;
          setSelectedGroupId(null);
          setSelectedGroupType(null);
          setSelectedGroupCount(0);
        }

        function deleteSelectedGroup() {
          const groupIds = selectedGroupIdsRef.current;
          if (groupIds.length === 0) return false;
          pushUndoSnapshot();
          particles = particles.filter((particle) => !particle.groupId || !groupIds.includes(particle.groupId));
          groups = groups.filter((group) => !groupIds.includes(group.id));
          clearSelectedGroup();
          return true;
        }

        function getSelectedBounds() {
          const groupIds = selectedGroupIdsRef.current;
          if (groupIds.length === 0) return null;

          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          let found = false;

          for (const particle of particles) {
            if (!particle.groupId || !groupIds.includes(particle.groupId)) continue;
            found = true;
            minX = Math.min(minX, particle.x);
            minY = Math.min(minY, particle.y);
            maxX = Math.max(maxX, particle.x);
            maxY = Math.max(maxY, particle.y);
          }

          return found ? { minX, minY, maxX, maxY } : null;
        }

        function getGroupBounds(groupId: number) {
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          let found = false;

          for (const particle of particles) {
            if (particle.groupId !== groupId) continue;
            found = true;
            minX = Math.min(minX, particle.x);
            minY = Math.min(minY, particle.y);
            maxX = Math.max(maxX, particle.x);
            maxY = Math.max(maxY, particle.y);
          }

          return found ? { minX, minY, maxX, maxY } : null;
        }

        function getSelectedGroup(expectedType?: ParticleType) {
          const groupId = selectedGroupIdRef.current;
          if (!groupId) return null;
          const group = groups.find((item) => item.id === groupId);
          if (!group || (expectedType && group.type !== expectedType)) return null;
          return group;
        }

        function getSelectedGroups(expectedType?: ParticleType) {
          const groupIds = selectedGroupIdsRef.current;
          return groups.filter((group) => groupIds.includes(group.id) && (!expectedType || group.type === expectedType));
        }

        function getGroupForParticle(particle: Particle) {
          if (!particle.groupId) return null;
          return groups.find((item) => item.id === particle.groupId) ?? null;
        }

        function rebuildTextGroup(group: ObjectGroup) {
          if (group.type !== "text" || !group.text || !group.size) return;
          rebuildGroup(group);
        }

        function rebuildGroup(group: ObjectGroup) {
          particles = particles.filter((particle) => particle.groupId !== group.id);

          if (group.type === "text" && group.text && group.size) {
            particles = [
              ...particles,
              ...buildTextParticles(
                group.text,
                group.x,
                group.y,
                group.size,
                group.id,
                group.density,
                group.randomSeed,
                group.rotation ?? 0,
                group.letterSpacing ?? 0,
                group.fontId ?? INITIAL_PRESET.frontFontId,
              ),
            ];
          }

          if (group.type === "drawing" && group.path) {
            particles = [...particles, ...buildDrawingParticles(group.path, group.id, group.density, group.randomSeed)];
          }

          if (group.type === "image" && group.imageElement && group.imageWidth && group.imageHeight) {
            particles = [
              ...particles,
              ...buildImageParticles(
                group.imageElement,
                group.x,
                group.y,
                group.imageWidth,
                group.imageHeight,
                group.id,
                group.density,
                group.randomSeed,
                group.rotation ?? 0,
              ),
            ];
          }
        }

        function rebuildAllGroups(limit = particleLimitRef.current) {
          const selectedId = selectedGroupIdRef.current;
          const rebuilt: Particle[] = [];

          for (const group of groups) {
            group.density = limit;
            if (group.type === "text" && group.text && group.size) {
              rebuilt.push(
                ...buildTextParticles(
                  group.text,
                  group.x,
                  group.y,
                  group.size,
                  group.id,
                  group.density,
                  group.randomSeed,
                  group.rotation ?? 0,
                  group.letterSpacing ?? 0,
                  group.fontId ?? INITIAL_PRESET.frontFontId,
                ),
              );
            }
            if (group.type === "drawing" && group.path) {
              rebuilt.push(...buildDrawingParticles(group.path, group.id, group.density, group.randomSeed));
            }
            if (group.type === "image" && group.imageElement && group.imageWidth && group.imageHeight) {
              rebuilt.push(
                ...buildImageParticles(
                  group.imageElement,
                  group.x,
                  group.y,
                  group.imageWidth,
                  group.imageHeight,
                  group.id,
                  group.density,
                  group.randomSeed,
                  group.rotation ?? 0,
                ),
              );
            }
          }

          particles = rebuilt;
          if (selectedId && groups.some((group) => group.id === selectedId)) {
            selectGroup(selectedId);
          }
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

  useEffect(() => {
    recordingClipsRef.current = recordingClips;
  }, [recordingClips]);

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current);
      recordingClipsRef.current.forEach((clip) => URL.revokeObjectURL(clip.url));
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
        if (apiRef.current?.undo()) event.preventDefault();
        return;
      }

      if (event.key !== "Backspace" && event.key !== "Delete") return;
      if (!selectedGroupIdRef.current) return;
      event.preventDefault();
      deleteSelectedGroup();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  function submitText(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const updated =
      selectedGroupId && selectedGroupType === "text" ? apiRef.current?.updateSelectedText(text, textSize) : false;
    if (!updated) apiRef.current?.addTextParticles(text, textSize);
  }

  function handleImageImport(file: File | undefined) {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      apiRef.current?.addImageParticles(reader.result);
    };
    reader.readAsDataURL(file);
  }

  function downloadDataUrl(dataUrl: string, filename: string) {
    const link = document.createElement("a");
    link.href = dataUrl;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function downloadBlobFallback(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    downloadDataUrl(url, filename);
    window.setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  async function saveBlobAs(
    blob: Blob,
    filename: string,
    description: string,
    extensions: string[],
    mimeType = blob.type || "application/octet-stream",
  ) {
    const pickerMimeType = mimeType.split(";")[0] || "application/octet-stream";
    const filePicker = (
      window as typeof window & {
        showSaveFilePicker?: (options: {
          suggestedName: string;
          types?: Array<{
            description: string;
            accept: Record<string, string[]>;
          }>;
        }) => Promise<{
          createWritable: () => Promise<{
            write: (data: Blob) => Promise<void>;
            close: () => Promise<void>;
          }>;
        }>;
      }
    ).showSaveFilePicker;

    if (filePicker) {
      try {
        const handle = await filePicker({
          suggestedName: filename,
          types: [
            {
              description,
              accept: {
                [pickerMimeType]: extensions,
              },
            },
          ],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }

    downloadBlobFallback(blob, filename);
  }

  function clearRecordingTimer() {
    if (recordingTimerRef.current === null) return;
    window.clearInterval(recordingTimerRef.current);
    recordingTimerRef.current = null;
  }

  function formatDuration(durationMs: number) {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
    const seconds = (totalSeconds % 60).toString().padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  function formatBytes(bytes: number) {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  }

  async function exportPng() {
    const dataUrl = apiRef.current?.exportPng();
    if (!dataUrl) return;
    const blob = await fetch(dataUrl).then((response) => response.blob());
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const ppiBytes = addPngPpiMetadata(bytes, PNG_EXPORT_PPI);
    const pngBlob = new Blob([ppiBytes.buffer.slice(0) as ArrayBuffer], { type: "image/png" });
    await saveBlobAs(pngBlob, `gravity-${Date.now()}.png`, "PNG Image", [".png"], "image/png");
  }

  async function exportSvg() {
    const svg = apiRef.current?.exportSvg();
    if (!svg) return;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    await saveBlobAs(blob, `gravity-${Date.now()}.svg`, "SVG Image", [".svg"], "image/svg+xml");
  }

  async function startRecording() {
    const started = await apiRef.current?.startRecording((blob, extension) => {
      const finishedAt = Date.now();
      if (blob.size === 0) {
        clearRecordingTimer();
        setIsRecording(false);
        window.alert("녹화 데이터가 생성되지 않았습니다. 브라우저의 캔버스 녹화 지원을 확인해주세요.");
        return;
      }
      const filename = `gravity-recording-${finishedAt}.${extension}`;
      const url = URL.createObjectURL(blob);
      clearRecordingTimer();
      setRecordingElapsed(finishedAt - recordingStartedAtRef.current);
      setRecordingClips((clips) => [
        {
          id: finishedAt,
          blob,
          url,
          filename,
          durationMs: finishedAt - recordingStartedAtRef.current,
          size: blob.size,
        },
        ...clips,
      ]);
      setIsRecording(false);
    });
    if (started) {
      recordingStartedAtRef.current = Date.now();
      setRecordingElapsed(0);
      clearRecordingTimer();
      recordingTimerRef.current = window.setInterval(() => {
        setRecordingElapsed(Date.now() - recordingStartedAtRef.current);
      }, 250);
      setIsRecording(true);
      return;
    }
    window.alert("이 브라우저에서 QuickTime 호환 MP4 인코딩을 지원하지 않습니다.");
  }

  function stopRecording() {
    apiRef.current?.stopRecording();
  }

  async function saveRecordingClip(clip: RecordingClip) {
    await saveBlobAs(
      clip.blob,
      clip.filename,
      "Video",
      [clip.filename.endsWith(".mp4") ? ".mp4" : ".webm"],
      clip.blob.type || "video/webm",
    );
  }

  function deleteRecordingClip(clipId: number) {
    setRecordingClips((clips) => {
      const target = clips.find((clip) => clip.id === clipId);
      if (target) URL.revokeObjectURL(target.url);
      return clips.filter((clip) => clip.id !== clipId);
    });
  }

  function setToolMode(nextMode: ToolMode) {
    toolModeRef.current = nextMode;
    setToolModeState(nextMode);
  }

  function setCanvasRatio(nextRatio: CanvasRatio) {
    setCanvasRatioState(nextRatio);
    if (apiRef.current) {
      apiRef.current.setCanvasRatio(nextRatio);
    } else {
      canvasRatioRef.current = nextRatio;
    }
  }

  function setTextSize(nextSize: number) {
    if (!selectedGroupId || selectedGroupType !== "text") return;
    textSizeRef.current = nextSize;
    setTextSizeState(nextSize);
    if (
      selectedGroupId &&
      selectedGroupType === "text" &&
      typeof apiRef.current?.updateSelectedTextSize === "function"
    ) {
      apiRef.current?.updateSelectedTextSize(nextSize);
    }
  }

  function setLetterSpacing(nextSpacing: number) {
    if (!selectedGroupId || selectedGroupType !== "text") return;
    letterSpacingRef.current = nextSpacing;
    setLetterSpacingState(nextSpacing);
    if (
      selectedGroupId &&
      selectedGroupType === "text" &&
      typeof apiRef.current?.updateSelectedLetterSpacing === "function"
    ) {
      apiRef.current?.updateSelectedLetterSpacing(nextSpacing);
    }
  }

  function setTextFont(nextFont: TextFontId) {
    textFontRef.current = nextFont;
    setTextFontState(nextFont);
    if (selectedGroupId && selectedGroupType === "text") {
      apiRef.current?.updateSelectedFont(nextFont);
    }
  }

  function setParticleSize(nextSize: number) {
    if (!selectedGroupId) return;
    particleSizeRef.current = nextSize;
    setParticleSizeState(nextSize);
    if (selectedGroupId && typeof apiRef.current?.updateSelectedParticleSize === "function") {
      apiRef.current?.updateSelectedParticleSize(nextSize);
    }
  }

  function setParticleLimit(nextLimit: number) {
    if (!selectedGroupId) return;
    particleLimitRef.current = nextLimit;
    setParticleLimitState(nextLimit);
    apiRef.current?.setParticleLimit(nextLimit);
  }

  function setParticleColor(nextColor: string) {
    particleColorRef.current = nextColor;
    setParticleColorState(nextColor);
    if (selectedGroupId && typeof apiRef.current?.updateSelectedColor === "function") {
      apiRef.current?.updateSelectedColor(nextColor);
    }
  }

  function setLineWidth(nextWidth: number) {
    if (!selectedGroupId) return;
    lineWidthRef.current = nextWidth;
    setLineWidthState(nextWidth);
    if (selectedGroupId && typeof apiRef.current?.updateSelectedLineWidth === "function") {
      apiRef.current?.updateSelectedLineWidth(nextWidth);
    }
  }

  function setLineColor(nextColor: string) {
    if (!selectedGroupId) return;
    lineColorRef.current = nextColor;
    setLineColorState(nextColor);
    if (selectedGroupId && typeof apiRef.current?.updateSelectedLineColor === "function") {
      apiRef.current?.updateSelectedLineColor(nextColor);
    }
  }

  function setRandomSeed(nextSeed: number) {
    if (!selectedGroupId) return;
    randomSeedRef.current = nextSeed;
    setRandomSeedState(nextSeed);
    if (selectedGroupId && typeof apiRef.current?.updateSelectedRandomSeed === "function") {
      apiRef.current?.updateSelectedRandomSeed(nextSeed);
    }
  }

  function handleTextChange(nextText: string) {
    setText(nextText);
    if (
      selectedGroupId &&
      selectedGroupType === "text" &&
      typeof apiRef.current?.updateSelectedTextContent === "function"
    ) {
      apiRef.current?.updateSelectedTextContent(nextText);
    }
  }

  function deleteSelectedGroup() {
    if (!apiRef.current?.deleteSelectedGroup()) return;
    setSelectedGroupId(null);
    setSelectedGroupType(null);
    setSelectedGroupCount(0);
  }

  return (
    <main className="toolShell">
      <div className="panelStack">
        <section className="controlBar" aria-label="드로잉 설정">
          <form className="textForm" onSubmit={submitText}>
            <input
              aria-label="입자로 변환할 텍스트"
              value={text}
              onChange={(event) => handleTextChange(event.target.value)}
              placeholder="텍스트 입력"
            />
            <button type="submit">{selectedGroupType === "text" ? "텍스트 수정" : "텍스트 추가"}</button>
          </form>
          <input
            ref={imageInputRef}
            className="fileInput"
            aria-label="사진 불러오기"
            type="file"
            accept="image/*"
            onChange={(event) => {
              handleImageImport(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <button type="button" className="importButton" onClick={() => imageInputRef.current?.click()}>
            사진 불러오기
          </button>
          <button type="button" className="helpButton" onClick={() => setIsHelpOpen(true)}>
            사용 방법
          </button>
          <label className="selectControl">
            <span>캔버스</span>
            <select
              aria-label="캔버스 비율"
              value={canvasRatio}
              onChange={(event) => setCanvasRatio(event.target.value as CanvasRatio)}
            >
              <option value="1:1">1:1</option>
              <option value="4:3">4:3</option>
              <option value="3:4">3:4</option>
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
            </select>
          </label>
          <label className="selectControl fontSelectControl">
            <span>폰트</span>
            <select
              aria-label="폰트"
              value={textFont}
              onChange={(event) => setTextFont(event.target.value as TextFontId)}
            >
              {TEXT_FONT_OPTIONS.map((font) => (
                <option key={font.id} value={font.id}>
                  {font.label}
                </option>
              ))}
            </select>
          </label>
          <label className="sizeControl">
            <span>글자 크기</span>
            <input
              aria-label="글자 크기"
              type="range"
              min="50"
              max="500"
              step="10"
              value={textSize}
              disabled={!selectedGroupId || selectedGroupType !== "text"}
              onChange={(event) => setTextSize(Number(event.target.value))}
            />
            <output>{textSize}</output>
          </label>
          <label className="sizeControl">
            <span>커닝</span>
            <input
              aria-label="커닝"
              type="range"
              min="-40"
              max="120"
              step="1"
              value={letterSpacing}
              disabled={!selectedGroupId || selectedGroupType !== "text"}
              onChange={(event) => setLetterSpacing(Number(event.target.value))}
            />
            <output>{letterSpacing}</output>
          </label>
          <label className="sizeControl">
            <span>입자 크기</span>
            <input
              aria-label="입자 크기"
              type="range"
              min="1"
              max="12"
              step="0.5"
              value={particleSize}
              disabled={!selectedGroupId}
              onChange={(event) => setParticleSize(Number(event.target.value))}
            />
            <output>{particleSize}</output>
          </label>
          <label className="sizeControl">
            <span>입자 밀도</span>
            <input
              aria-label="입자 밀도"
              type="range"
              min="500"
              max="12000"
              step="100"
              value={particleLimit}
              disabled={!selectedGroupId}
              onChange={(event) => setParticleLimit(Number(event.target.value))}
            />
            <output>{particleLimit}</output>
          </label>
          <label className="colorControl">
            <span>입자 색</span>
            <input
              aria-label="입자 색"
              type="color"
              value={particleColor}
              onChange={(event) => setParticleColor(event.target.value)}
            />
          </label>
          <label className="sizeControl">
            <span>선 굵기</span>
            <input
              aria-label="선 굵기"
              type="range"
              min="0.25"
              max="4"
              step="0.05"
              value={lineWidth}
              disabled={!selectedGroupId}
              onChange={(event) => setLineWidth(Number(event.target.value))}
            />
            <output>{lineWidth.toFixed(2)}</output>
          </label>
          <label className="colorControl">
            <span>선 색상</span>
            <input
              aria-label="선 색상"
              type="color"
              value={lineColor}
              disabled={!selectedGroupId}
              onChange={(event) => setLineColor(event.target.value)}
            />
          </label>
          <label className="sizeControl">
            <span>랜덤 시드</span>
            <input
              aria-label="랜덤 시드"
              type="range"
              min="0"
              max="999"
              step="1"
              value={randomSeed}
              disabled={!selectedGroupId}
              onChange={(event) => setRandomSeed(Number(event.target.value))}
            />
            <output>{randomSeed}</output>
          </label>
          <button type="button" onClick={() => void exportPng()}>
            PNG 내보내기
          </button>
          <button type="button" onClick={() => void exportSvg()}>
            SVG 내보내기
          </button>
          {isRecording ? (
            <button type="button" className="recordingButton active" onClick={stopRecording}>
              <span>녹화 종료</span>
              <output>{formatDuration(recordingElapsed)}</output>
            </button>
          ) : (
            <button type="button" className="recordingButton" onClick={() => void startRecording()}>
              녹화 시작
            </button>
          )}
          {recordingClips.length > 0 && (
            <section className="recordingTimeline" aria-label="녹화 목록">
              <div className="recordingList">
                {recordingClips.map((clip, index) => (
                  <div className="recordingClip" key={clip.id}>
                    <span>{`REC ${recordingClips.length - index}`}</span>
                    <span>{formatDuration(clip.durationMs)}</span>
                    <span>{formatBytes(clip.size)}</span>
                    <button type="button" onClick={() => void saveRecordingClip(clip)}>
                      저장
                    </button>
                    <button type="button" onClick={() => deleteRecordingClip(clip.id)}>
                      삭제
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}
        </section>
        <section className="toolPanel" aria-label="도구 선택">
          <div className="modeToggle" aria-label="도구 모드">
            <button
              type="button"
              className={toolMode === "select" ? "active" : ""}
              aria-pressed={toolMode === "select"}
              onClick={() => setToolMode("select")}
            >
              선택
            </button>
            <button
              type="button"
              className={toolMode === "draw" ? "active" : ""}
              aria-pressed={toolMode === "draw"}
              onClick={() => setToolMode("draw")}
            >
              그리기
            </button>
            <button
              type="button"
              className={toolMode === "attract" ? "active" : ""}
              aria-pressed={toolMode === "attract"}
              onClick={() => setToolMode("attract")}
            >
              끌어당김
            </button>
          </div>
          <section className="deletePanel" aria-label="삭제 관리">
            <button type="button" disabled={!selectedGroupId} onClick={deleteSelectedGroup}>
              {selectedGroupCount > 1 ? `${selectedGroupCount}개삭제` : "선택삭제"}
            </button>
            <button type="button" onClick={() => apiRef.current?.clearParticles()}>
              전체삭제
            </button>
          </section>
        </section>
      </div>
      {isHelpOpen && (
        <section className="helpOverlay" aria-label="사용 방법 안내" role="dialog" aria-modal="true">
          <div className="helpPanel">
            <header className="helpHeader">
              <div>
                <p>
                  GRAVITY TOOL <span>ver. 2026.05.25</span>
                </p>
                <h1>입자 드로잉 사용 방법</h1>
              </div>
              <button type="button" onClick={() => setIsHelpOpen(false)} aria-label="사용 방법 닫기">
                닫기
              </button>
            </header>
            <div className="helpGrid">
              <article>
                <h2>01. 텍스트</h2>
                <p>텍스트 입력 후 추가하면 글자가 입자 레이어로 생성됩니다. 선택 도구로 글자를 클릭하면 내용, 폰트, 크기, 커닝, 밀도, 색상, 선 굵기를 수정할 수 있습니다.</p>
              </article>
              <article>
                <h2>02. 선택 / 이동</h2>
                <p>선택 도구에서 개체를 클릭하면 바운딩 박스가 나타납니다. 드래그로 이동하고, 모서리 핸들로 크기 조절과 회전을 할 수 있습니다. 빈 영역을 드래그하면 여러 개를 같이 선택합니다.</p>
              </article>
              <article>
                <h2>03. 그리기</h2>
                <p>그리기 도구를 선택한 뒤 캔버스 안에서 드래그하면 선이 입자로 변환됩니다. 만들어진 선도 텍스트처럼 선택, 이동, 삭제, 색상 변경이 가능합니다.</p>
              </article>
              <article>
                <h2>04. 끌어당김</h2>
                <p>끌어당김 도구에서 캔버스를 누르고 있으면 주변 입자들이 클릭 지점으로 모입니다. 입자들은 서로 충돌하며 흔들리고, 마우스를 놓으면 원래 위치로 돌아갑니다.</p>
              </article>
              <article>
                <h2>05. 사진 불러오기</h2>
                <p>사진을 불러오면 이미지가 입자로 해석되어 캔버스에 배치됩니다. 이미지 입자도 선택, 이동, 끌어당김 효과의 영향을 받습니다.</p>
              </article>
              <article>
                <h2>06. 캔버스 / 저장</h2>
                <p>캔버스 비율은 1:1, 4:3, 3:4, 16:9, 9:16 중 선택합니다. PNG, SVG, 녹화 파일은 패널을 제외하고 흰 캔버스 영역만 내보냅니다.</p>
              </article>
            </div>
            <footer className="helpFooter">
              <span>Backspace / Delete: 선택 삭제</span>
              <span>전체삭제: 모든 레이어 초기화</span>
            </footer>
          </div>
        </section>
      )}
      <div ref={hostRef} className="canvasHost" />
    </main>
  );
}
