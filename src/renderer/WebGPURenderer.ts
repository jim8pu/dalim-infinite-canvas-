import { Point, Stroke, Layer, Box, LaserPoint, TempShape, ViewState } from '../core/types';
import { ZoomFloor } from '../canvas/zoom';
import { ACCENT_BLUE, LASER_COLOR } from '../core/constants';
import { transformPointToFloor } from '../canvas/zoom';

export class WebGPURenderer {
        canvas: HTMLCanvasElement;
        adapter: GPUAdapter | null;
        device: GPUDevice | null;
        context: GPUCanvasContext | null;
        pipeline: GPURenderPipeline | null;
        overlayPipeline: GPURenderPipeline | null;
        viewUniformBuffer: GPUBuffer | null;
        viewBindGroup: GPUBindGroup | null;
        overlayVertexBuffer: GPUBuffer | null;
        maxOverlayVertices: number;
        shaderModule: GPUShaderModule | null;
        presentationFormat?: GPUTextureFormat;
        depthStencilTexture?: GPUTexture;
        depthStencilView?: GPUTextureView;
        stencilRef?: number;
        viewBindGroupLayout?: GPUBindGroupLayout;
        _lastPanX?: number;
        _lastPanY?: number;

        constructor(canvas: HTMLCanvasElement) {
            this.canvas = canvas;
            this.adapter = null;
            this.device = null;
            this.context = null;
            this.pipeline = null;
            this.overlayPipeline = null;

            this.viewUniformBuffer = null;
            this.viewBindGroup = null;

            // MODIFIED: We no longer use monolithic stroke buffers.
            // Each stroke will manage its own buffers.
            // We keep overlay buffers for transient UI elements (lasso, selection box, laser).
            this.overlayVertexBuffer = null;

            this.maxOverlayVertices = 10000; // 10k vertices for overlays

            // Shader code in WGSL
            this.shaderModule = null;
        }

        async init() {
            if (!navigator.gpu) {
                throw new Error("WebGPU not supported on this browser.");
            }
            this.adapter = await navigator.gpu.requestAdapter();
            if (!this.adapter) {
                throw new Error("No appropriate GPUAdapter found.");
            }
            this.device = await this.adapter.requestDevice();
            this.context = this.canvas.getContext('webgpu');

            this.presentationFormat = navigator.gpu.getPreferredCanvasFormat();

            this.context!.configure({
                device: this.device,
                format: this.presentationFormat,
                alphaMode: 'premultiplied',
            });

            this.createShaders();
            this.createBuffers();
            this.createPipelines();
        }

        // --- Utility to convert hex color to normalized RGBA array ---
        hexToRgba(hex: string, opacity: number = 1.0): number[] {
            let r = 0, g = 0, b = 0;
            if (hex.length === 4) {
                r = parseInt(hex[1] + hex[1], 16);
                g = parseInt(hex[2] + hex[2], 16);
                b = parseInt(hex[3] + hex[3], 16);
            } else if (hex.length === 7) {
                r = parseInt(hex.substring(1, 3), 16);
                g = parseInt(hex.substring(3, 5), 16);
                b = parseInt(hex.substring(5, 7), 16);
            }
            return [r / 255, g / 255, b / 255, opacity];
        }

        createShaders() {
            // --- Shader Code (Unchanged) ---
            const wgslCode = `
                struct ViewUniforms {
                    viewProjectionMatrix: mat4x4<f32>, 
                };

                @group(0) @binding(0) var<uniform> view: ViewUniforms;

                struct VertexInput {
                    @location(0) position: vec2<f32>,
                    @location(1) color: vec4<f32>,
                };

                struct VertexOutput {
                    @builtin(position) position: vec4<f32>,
                    @location(0) color: vec4<f32>,
                };
                
                @vertex
                fn vs_main(in: VertexInput) -> VertexOutput {
                    var out: VertexOutput;
                    out.position = view.viewProjectionMatrix * vec4<f32>(in.position, 0.0, 1.0);
                    out.color = in.color;
                    return out;
                }

                @fragment
                fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
                    return vec4<f32>(in.color.rgb * in.color.a, in.color.a);
                }
            `;

            this.shaderModule = this.device!.createShaderModule({ code: wgslCode });
        }

        createBuffers() {
            // --- Uniform Buffer ---
            this.viewUniformBuffer = this.device!.createBuffer({
                size: 16 * 4, // 16 floats
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });

            // --- Overlay Vertex Buffer (Dynamic) ---
            // We keep this for UI elements that change every frame anyway
            this.overlayVertexBuffer = this.device!.createBuffer({
                size: this.maxOverlayVertices * 6 * 4,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });

            // --- Depth-Stencil Texture for overdraw prevention ---
            this._createDepthStencilTexture();
            this.stencilRef = 0; // Incrementing stencil reference counter
        }

        _createDepthStencilTexture() {
            if (this.depthStencilTexture) {
                this.depthStencilTexture.destroy();
            }
            this.depthStencilTexture = this.device!.createTexture({
                size: {
                    width: Math.max(1, this.canvas.width),
                    height: Math.max(1, this.canvas.height),
                },
                format: 'depth24plus-stencil8',
                usage: GPUTextureUsage.RENDER_ATTACHMENT,
            });
            this.depthStencilView = this.depthStencilTexture.createView();
        }

        createPipelines() {
            const vertexBufferLayout: GPUVertexBufferLayout = {
                arrayStride: 6 * 4, // 6 floats * 4 bytes/float
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
                    { shaderLocation: 1, offset: 2 * 4, format: 'float32x4' }, // color
                ],
            };

            this.viewBindGroupLayout = this.device!.createBindGroupLayout({
                entries: [{
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'uniform' },
                }]
            });

            this.viewBindGroup = this.device!.createBindGroup({
                layout: this.viewBindGroupLayout,
                entries: [{
                    binding: 0,
                    resource: { buffer: this.viewUniformBuffer! },
                }]
            });

            const pipelineLayout = this.device!.createPipelineLayout({
                bindGroupLayouts: [this.viewBindGroupLayout]
            });

            const blendState: GPUBlendState = {
                color: {
                    srcFactor: 'one',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                },
                alpha: {
                    srcFactor: 'one',
                    dstFactor: 'one-minus-src-alpha',
                    operation: 'add',
                },
            };

            // --- Stroke Pipeline (Triangles) with stencil for overdraw prevention ---
            this.pipeline = this.device!.createRenderPipeline({
                layout: pipelineLayout,
                vertex: {
                    module: this.shaderModule!,
                    entryPoint: 'vs_main',
                    buffers: [vertexBufferLayout],
                },
                fragment: {
                    module: this.shaderModule!,
                    entryPoint: 'fs_main',
                    targets: [{ format: this.presentationFormat!, blend: blendState }],
                },
                primitive: {
                    topology: 'triangle-list',
                },
                depthStencil: {
                    format: 'depth24plus-stencil8',
                    depthWriteEnabled: false,
                    depthCompare: 'always',
                    stencilFront: {
                        compare: 'not-equal',
                        failOp: 'keep',
                        passOp: 'replace',
                        depthFailOp: 'keep',
                    },
                    stencilBack: {
                        compare: 'not-equal',
                        failOp: 'keep',
                        passOp: 'replace',
                        depthFailOp: 'keep',
                    },
                    stencilReadMask: 0xFF,
                    stencilWriteMask: 0xFF,
                },
            });

            // --- Overlay Pipeline (Lines) ---
            // Must include depthStencil for render pass compatibility,
            // but stencil always passes and never writes (overlays draw freely)
            this.overlayPipeline = this.device!.createRenderPipeline({
                layout: pipelineLayout,
                vertex: {
                    module: this.shaderModule!,
                    entryPoint: 'vs_main',
                    buffers: [vertexBufferLayout],
                },
                fragment: {
                    module: this.shaderModule!,
                    entryPoint: 'fs_main',
                    targets: [{ format: this.presentationFormat!, blend: blendState }],
                },
                primitive: {
                    topology: 'line-list',
                },
                depthStencil: {
                    format: 'depth24plus-stencil8',
                    depthWriteEnabled: false,
                    depthCompare: 'always',
                    stencilFront: {
                        compare: 'always',
                        failOp: 'keep',
                        passOp: 'keep',
                        depthFailOp: 'keep',
                    },
                    stencilBack: {
                        compare: 'always',
                        failOp: 'keep',
                        passOp: 'keep',
                        depthFailOp: 'keep',
                    },
                    stencilReadMask: 0x00,
                    stencilWriteMask: 0x00,
                },
            });
        }

        resize(width: number, height: number) {
            const dpr = window.devicePixelRatio || 1;
            this.canvas.width = Math.round(width * dpr);
            this.canvas.height = Math.round(height * dpr);
            this.canvas.style.width = `${width}px`;
            this.canvas.style.height = `${height}px`;
            // Recreate depth-stencil texture to match new canvas size
            if (this.device && this.canvas) {
                this._createDepthStencilTexture();
            }
        }

        // --- MODIFIED: Data-Returning Tessellators ---
        // These now return arrays instead of pushing to a global buffer

        // --- Catmull-Rom Spline Subdivision (Zoom-Aware + View-Frustum Culled) ---
        // screenScale: combined scale factor (cameraScale * floorEffScale) to convert world→screen px
        // viewRect: { minX, minY, maxX, maxY } visible world-space rectangle (null = subdivide all)
        // Target: each subdivided segment ≤ 3 screen pixels. Off-screen segments get 1 subdivision.
        catmullRomSubdivide(points: Point[], screenScale: number, viewRect: { minX: number; minY: number; maxX: number; maxY: number } | null): Point[] {
            if (points.length < 2) return points;

            const TARGET_SCREEN_PX = 3;
            // Expand view rect by a margin so we don't get edge artifacts
            let vr = null;
            if (viewRect) {
                const margin = 50 / screenScale; // 50 screen px margin in world units
                vr = {
                    minX: viewRect.minX - margin,
                    minY: viewRect.minY - margin,
                    maxX: viewRect.maxX + margin,
                    maxY: viewRect.maxY + margin,
                };
            }

            if (points.length === 2) {
                const d = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
                const screenDist = d * screenScale;
                const steps = Math.max(1, Math.min(256, Math.round(screenDist / TARGET_SCREEN_PX)));
                const result = [];
                for (let t = 0; t <= steps; t++) {
                    const frac = t / steps;
                    result.push({
                        x: points[0].x + (points[1].x - points[0].x) * frac,
                        y: points[0].y + (points[1].y - points[0].y) * frac,
                    });
                }
                return result;
            }

            const result = [];
            const n = points.length;

            for (let i = 0; i < n - 1; i++) {
                const p0 = points[Math.max(0, i - 1)];
                const p1 = points[i];
                const p2 = points[i + 1];
                const p3 = points[Math.min(n - 1, i + 2)];

                const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);

                // --- View-frustum culling per segment ---
                // Check if the segment bounding box (P0..P3 control points) is visible
                let isVisible = true;
                if (vr) {
                    const segMinX = Math.min(p0.x, p1.x, p2.x, p3.x);
                    const segMaxX = Math.max(p0.x, p1.x, p2.x, p3.x);
                    const segMinY = Math.min(p0.y, p1.y, p2.y, p3.y);
                    const segMaxY = Math.max(p0.y, p1.y, p2.y, p3.y);
                    isVisible = !(segMaxX < vr.minX || segMinX > vr.maxX ||
                        segMaxY < vr.minY || segMinY > vr.maxY);
                }

                let steps;
                if (isVisible) {
                    // Visible: subdivide at screen-space density
                    const screenDist = dist * screenScale;
                    steps = Math.max(1, Math.min(256, Math.round(screenDist / TARGET_SCREEN_PX)));
                } else {
                    // Off-screen: minimal subdivision (just emit endpoints)
                    steps = 1;
                }

                for (let s = 0; s < steps; s++) {
                    const t = s / steps;
                    const t2 = t * t;
                    const t3 = t2 * t;

                    const x = 0.5 * (
                        (2 * p1.x) +
                        (-p0.x + p2.x) * t +
                        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
                        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
                    );
                    const y = 0.5 * (
                        (2 * p1.y) +
                        (-p0.y + p2.y) * t +
                        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
                        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
                    );
                    result.push({ x, y });
                }
            }
            // Always include the very last point
            result.push({ x: points[n - 1].x, y: points[n - 1].y });
            return result;
        }

        tessellatePenStroke(stroke: Stroke, cameraFloor: ZoomFloor, cameraScale: number) {
            const vertices: number[] = [];
            const indices: number[] = [];

            const points = stroke.points;
            if (points.length < 2) return { vertices, indices };

            const rawTransformed = points.map((pt: Point) => transformPointToFloor(pt, stroke.floorIndex, cameraFloor));

            const color = this.hexToRgba(stroke.color, (stroke.opacity / 100) * (stroke.isErasing ? 0.3 : 1.0));
            let effScale = 1;
            if (stroke.floorIndex < cameraFloor.index) {
                effScale = Math.pow(cameraFloor.BASE, cameraFloor.index - stroke.floorIndex);
            } else if (stroke.floorIndex > cameraFloor.index) {
                effScale = 1 / Math.pow(cameraFloor.BASE, stroke.floorIndex - cameraFloor.index);
            }
            const actualWidth = stroke.worldWidth !== undefined ? stroke.worldWidth : (stroke.lineWidth || 1);
            const halfWidth = (actualWidth * effScale) / 2;

            // --- Zoom-aware subdivision ---
            // Combined scale: how many screen pixels per world unit
            const screenScale = (cameraScale || 1) * effScale;

            // Compute visible world-space rectangle for view-frustum culling
            const dpr = window.devicePixelRatio || 1;
            const canvasW = this.canvas.width / dpr;
            const canvasH = this.canvas.height / dpr;
            const cameraPanX = this._lastPanX || 0;
            const cameraPanY = this._lastPanY || 0;
            const viewRect = {
                minX: -cameraPanX / cameraScale,
                minY: -cameraPanY / cameraScale,
                maxX: (canvasW - cameraPanX) / cameraScale,
                maxY: (canvasH - cameraPanY) / cameraScale,
            };

            const transformedPoints = this.catmullRomSubdivide(rawTransformed, screenScale, viewRect);

            const len = transformedPoints.length;

            // --- Build quad strip (same logic, uses subdivided points) ---
            // Precompute per-point normals
            const normals = new Array(len);
            for (let i = 0; i < len; i++) {
                const p = transformedPoints[i];
                let nx = 0, ny = 0;
                if (i === 0) {
                    const next = transformedPoints[1];
                    nx = next.y - p.y; ny = p.x - next.x;
                } else if (i === len - 1) {
                    const prev = transformedPoints[i - 1];
                    nx = p.y - prev.y; ny = prev.x - p.x;
                } else {
                    const prev = transformedPoints[i - 1];
                    const next = transformedPoints[i + 1];
                    nx = -(next.y - prev.y); ny = next.x - prev.x;
                }
                const nLen = Math.hypot(nx, ny);
                if (nLen > 0.001) { nx /= nLen; ny /= nLen; }
                else { nx = 1; ny = 0; }
                normals[i] = { x: nx, y: ny };
            }

            // Emit quad strip vertices
            for (let i = 0; i < len; i++) {
                const p = transformedPoints[i];
                const n = normals[i];
                vertices.push(p.x + n.x * halfWidth, p.y + n.y * halfWidth, ...color);
                vertices.push(p.x - n.x * halfWidth, p.y - n.y * halfWidth, ...color);
            }

            // Emit quad strip indices
            for (let i = 1; i < len; i++) {
                const i0 = (i - 1) * 2;
                const i1 = i0 + 1;
                const i2 = i * 2;
                const i3 = i2 + 1;
                indices.push(i0, i1, i2);
                indices.push(i1, i3, i2);
            }

            // --- Change 3: Round joins at interior bends ---
            // At each interior vertex where angle between segments exceeds ~5°,
            // insert a triangle fan on the outer side spanning the angular gap.
            const ANGLE_THRESHOLD = 0.087; // ~5 degrees in radians
            for (let i = 1; i < len - 1; i++) {
                const prev = transformedPoints[i - 1];
                const curr = transformedPoints[i];
                const next = transformedPoints[i + 1];

                // Incoming and outgoing directions
                const dInX = curr.x - prev.x, dInY = curr.y - prev.y;
                const dOutX = next.x - curr.x, dOutY = next.y - curr.y;
                const dInLen = Math.hypot(dInX, dInY);
                const dOutLen = Math.hypot(dOutX, dOutY);
                if (dInLen < 0.001 || dOutLen < 0.001) continue;

                const inDirX = dInX / dInLen, inDirY = dInY / dInLen;
                const outDirX = dOutX / dOutLen, outDirY = dOutY / dOutLen;

                // Angle between incoming and outgoing
                let dot = inDirX * outDirX + inDirY * outDirY;
                dot = Math.max(-1, Math.min(1, dot));
                const angle = Math.acos(dot);
                if (angle < ANGLE_THRESHOLD) continue;

                // Cross product sign determines which side is "outer"
                const cross = inDirX * outDirY - inDirY * outDirX;

                // Incoming normal (perpendicular to incoming direction)
                let inNx = -inDirY, inNy = inDirX;
                // Outgoing normal (perpendicular to outgoing direction)
                let outNx = -outDirY, outNy = outDirX;

                // Flip normals to outer side based on cross product
                if (cross > 0) {
                    inNx = -inNx; inNy = -inNy;
                    outNx = -outNx; outNy = -outNy;
                }

                // Number of fan segments proportional to angle
                const fanSegments = Math.max(4, Math.min(8, Math.round(angle / (Math.PI / 8))));

                // Angles of the two normals
                const startAngle = Math.atan2(inNy, inNx);
                let endAngle = Math.atan2(outNy, outNx);

                // Ensure we sweep in the correct (shorter) direction
                let sweep = endAngle - startAngle;
                if (cross > 0) {
                    // For positive cross, sweep should be positive
                    if (sweep < 0) sweep += 2 * Math.PI;
                } else {
                    // For negative cross, sweep should be negative
                    if (sweep > 0) sweep -= 2 * Math.PI;
                }

                // Center vertex of the fan = the joint point
                const centerIdx = vertices.length / 6;
                vertices.push(curr.x, curr.y, ...color);

                // Perimeter vertices
                for (let s = 0; s <= fanSegments; s++) {
                    const a = startAngle + (sweep * s) / fanSegments;
                    vertices.push(
                        curr.x + Math.cos(a) * halfWidth,
                        curr.y + Math.sin(a) * halfWidth,
                        ...color
                    );
                }

                // Fan triangles
                for (let s = 0; s < fanSegments; s++) {
                    indices.push(centerIdx, centerIdx + 1 + s, centerIdx + 2 + s);
                }
            }

            // --- Change 2: Round caps at endpoints ---
            const CAP_SEGMENTS = 12;
            // Cap at the start (faces backward)
            {
                const p0 = transformedPoints[0];
                const p1 = transformedPoints[1];
                const dirX = p1.x - p0.x, dirY = p1.y - p0.y;
                const dLen = Math.hypot(dirX, dirY);
                // Cap faces backward (away from stroke direction)
                let capDirX = 0, capDirY = -1;
                if (dLen > 0.001) {
                    capDirX = -dirX / dLen;
                    capDirY = -dirY / dLen;
                }
                // Semicircle spans 180° centered on capDir
                const capCenterAngle = Math.atan2(capDirY, capDirX);
                const centerIdx = vertices.length / 6;
                vertices.push(p0.x, p0.y, ...color);
                for (let s = 0; s <= CAP_SEGMENTS; s++) {
                    const a = capCenterAngle - Math.PI / 2 + (Math.PI * s) / CAP_SEGMENTS;
                    vertices.push(
                        p0.x + Math.cos(a) * halfWidth,
                        p0.y + Math.sin(a) * halfWidth,
                        ...color
                    );
                }
                for (let s = 0; s < CAP_SEGMENTS; s++) {
                    indices.push(centerIdx, centerIdx + 1 + s, centerIdx + 2 + s);
                }
            }
            // Cap at the end (faces forward)
            {
                const pLast = transformedPoints[len - 1];
                const pPrev = transformedPoints[len - 2];
                const dirX = pLast.x - pPrev.x, dirY = pLast.y - pPrev.y;
                const dLen = Math.hypot(dirX, dirY);
                let capDirX = 0, capDirY = 1;
                if (dLen > 0.001) {
                    capDirX = dirX / dLen;
                    capDirY = dirY / dLen;
                }
                const capCenterAngle = Math.atan2(capDirY, capDirX);
                const centerIdx = vertices.length / 6;
                vertices.push(pLast.x, pLast.y, ...color);
                for (let s = 0; s <= CAP_SEGMENTS; s++) {
                    const a = capCenterAngle - Math.PI / 2 + (Math.PI * s) / CAP_SEGMENTS;
                    vertices.push(
                        pLast.x + Math.cos(a) * halfWidth,
                        pLast.y + Math.sin(a) * halfWidth,
                        ...color
                    );
                }
                for (let s = 0; s < CAP_SEGMENTS; s++) {
                    indices.push(centerIdx, centerIdx + 1 + s, centerIdx + 2 + s);
                }
            }

            return { vertices, indices };
        }

        tessellateShape(shape: Stroke, cameraFloor: ZoomFloor) {
            const vertices: number[] = [];
            const indices: number[] = [];
            const color = this.hexToRgba(shape.color, ((shape.opacity ?? 100) / 100) * (shape.isErasing ? 0.3 : 1.0));
            
            const sx = shape.x ?? 0, sy = shape.y ?? 0, sw = shape.width ?? 0, sh = shape.height ?? 0;

            const p1 = transformPointToFloor({ x: sx, y: sy }, shape.floorIndex || 0, cameraFloor);
            const p2 = transformPointToFloor({ x: sx + sw, y: sy + sh }, shape.floorIndex || 0, cameraFloor);

            let x = Math.min(p1.x, p2.x);
            let y = Math.min(p1.y, p2.y);
            let w = Math.abs(p2.x - p1.x);
            let h = Math.abs(p2.y - p1.y);

            switch (shape.type) {
                case 'rectangle':
                    vertices.push(x, y, ...color);
                    vertices.push(x + w, y, ...color);
                    vertices.push(x, y + h, ...color);
                    vertices.push(x + w, y + h, ...color);
                    indices.push(0, 1, 2, 1, 3, 2);
                    break;
                case 'circle':
                    const cx = sx + sw / 2;
                    const cy = sy + sh / 2;
                    const rx = Math.abs(sw / 2);
                    const ry = Math.abs(sh / 2);
                    const segments = 32;
                    vertices.push(cx, cy, ...color);
                    
                    for (let i = 0; i <= segments; i++) {
                        const angle = (i / segments) * 2 * Math.PI;
                        vertices.push(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry, ...color);
                        if (i > 0) {
                            indices.push(0, i, i + 1);
                        }
                    }
                    break;
                case 'triangle':
                    vertices.push(sx + sw / 2, sy, ...color);
                    vertices.push(sx + sw, sy + sh, ...color);
                    vertices.push(sx, sy + sh, ...color);
                    indices.push(0, 1, 2);
                    break;
            }
            return { vertices, indices };
        }

        // --- Helper to upload a specific stroke to GPU ---
        updateStrokeBuffers(stroke: Stroke, cameraFloor: ZoomFloor, cameraScale: number) {
            // 1. Tessellate on CPU to get data arrays
            let data;
            if (stroke.type === 'pen' || stroke.type === 'highlighter') {
                data = this.tessellatePenStroke(stroke, cameraFloor, cameraScale);
            } else {
                data = this.tessellateShape(stroke, cameraFloor);
            }

            // If no geometry, nullify and return
            if (data.vertices.length === 0 || data.indices.length === 0) {
                if (stroke.gpuData) {
                    stroke.gpuData.vertexBuffer.destroy();
                    stroke.gpuData.indexBuffer.destroy();
                    stroke.gpuData = null;
                }
                return;
            }

            // 2. Create GPU buffers
            const vertexByteLength = data.vertices.length * 4;
            const indexByteLength = data.indices.length * 4;

            if (stroke.gpuData && stroke.gpuData.vertexBuffer instanceof GPUBuffer) {
                stroke.gpuData.vertexBuffer.destroy();
                stroke.gpuData.indexBuffer.destroy();
            }

            const vertexBuffer = this.device!.createBuffer({
                size: (vertexByteLength + 3) & ~3,
                usage: GPUBufferUsage.VERTEX,
                mappedAtCreation: true,
            });
            new Float32Array(vertexBuffer.getMappedRange()).set(data.vertices);
            vertexBuffer.unmap();

            const indexBuffer = this.device!.createBuffer({
                size: (indexByteLength + 3) & ~3,
                usage: GPUBufferUsage.INDEX,
                mappedAtCreation: true,
            });
            new Uint32Array(indexBuffer.getMappedRange()).set(data.indices);
            indexBuffer.unmap();

            // 3. Store on stroke object — include tessellationScale for zoom-aware cache invalidation
            stroke.gpuData = {
                vertexBuffer,
                indexBuffer,
                indexCount: data.indices.length,
                floorIndex: cameraFloor.index,
                tessellationScale: cameraScale || 1,
            };
        }

        // --- Overlay Tessellation (Lines) ---
        tessellateLasso(points: Point[], overlayVertices: number[]) {
            if (points.length < 2) return;
            const color = this.hexToRgba(ACCENT_BLUE, 0.8);
            for (let i = 0; i < points.length - 1; i++) {
                overlayVertices.push(points[i].x, points[i].y, ...color);
                overlayVertices.push(points[i + 1].x, points[i + 1].y, ...color);
            }
            overlayVertices.push(points[points.length - 1].x, points[points.length - 1].y, ...color);
            overlayVertices.push(points[0].x, points[0].y, ...color);
        }

        tessellateSelectionBox(box: Box, overlayVertices: number[]) {
            const color = this.hexToRgba(ACCENT_BLUE, 1.0);
            const x = box.x, y = box.y, w = box.width, h = box.height;
            const p1 = [x, y]; const p2 = [x + w, y];
            const p3 = [x + w, y + h]; const p4 = [x, y + h];
            overlayVertices.push(...p1, ...color, ...p2, ...color);
            overlayVertices.push(...p2, ...color, ...p3, ...color);
            overlayVertices.push(...p3, ...color, ...p4, ...color);
            overlayVertices.push(...p4, ...color, ...p1, ...color);
        }

        tessellateLaser(points: LaserPoint[], overlayVertices: number[]) {
            if (points.length < 2) return;
            const color = this.hexToRgba(LASER_COLOR, 0.9);
            for (let i = 0; i < points.length - 1; i++) {
                overlayVertices.push(points[i].x, points[i].y, ...color);
                overlayVertices.push(points[i + 1].x, points[i + 1].y, ...color);
            }
        }

        // --- Build view-projection matrix from scale + pan ---
        buildMatrix(scale: number, panX: number, panY: number): Float32Array {
            const dpr = window.devicePixelRatio || 1;
            const w = this.canvas.width / dpr;
            const h = this.canvas.height / dpr;
            return new Float32Array([
                2 * scale / w, 0, 0, 0,
                0, -2 * scale / h, 0, 0,
                0, 0, -1, 0,
                (2 * panX / w) - 1, (-2 * panY / h) + 1, 0, 1
            ]);
        }

        // --- Render Function (Unified Camera Space) ---
        render(viewState: ViewState, layers: Layer[], laserPoints: LaserPoint[], lassoPoints: Point[], selectionBox: Box | null, tempShape: TempShape | null) {
            if (!this.device) return;

            const cameraFloor = viewState.currentFloor;
            const cameraScale = viewState.scale;
            const cameraPan = viewState.panOffset;

            // Store pan for use by tessellatePenStroke's view-rect computation
            this._lastPanX = cameraPan.x;
            this._lastPanY = cameraPan.y;

            const matrix = this.buildMatrix(cameraScale, cameraPan.x, cameraPan.y);
            this.device.queue.writeBuffer(this.viewUniformBuffer!, 0, matrix.buffer);

            const commandEncoder = this.device.createCommandEncoder();
            const textureView = this.context!.getCurrentTexture().createView();

            // --- Stencil-enabled render pass ---
            this.stencilRef = 0;

            const passEncoder = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    view: textureView,
                    clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                }],
                depthStencilAttachment: {
                    view: this.depthStencilView!,
                    depthLoadOp: 'clear',
                    depthClearValue: 1.0,
                    depthStoreOp: 'store',
                    stencilLoadOp: 'clear',
                    stencilClearValue: 0,
                    stencilStoreOp: 'store',
                },
            });

            passEncoder.setPipeline(this.pipeline!);
            passEncoder.setBindGroup(0, this.viewBindGroup);

            if (layers) {
                layers.forEach(layer => {
                    if (layer.isVisible) {
                        (layer.strokes || []).forEach(stroke => {
                            const floorDelta = (stroke.floorIndex || 0) - cameraFloor.index;
                            if (floorDelta > 2) return;

                            // --- Zoom-aware cache invalidation ---
                            // Re-tessellate if: no gpuData, floor changed, OR zoom changed by >1.5x
                            let needsRetessellation = !stroke.gpuData ||
                                stroke.gpuData.floorIndex !== cameraFloor.index ||
                                !(stroke.gpuData.vertexBuffer instanceof GPUBuffer);

                            if (!needsRetessellation && stroke.gpuData?.tessellationScale) {
                                const zoomRatio = cameraScale / stroke.gpuData.tessellationScale;
                                if (zoomRatio > 1.5 || zoomRatio < (1 / 1.5)) {
                                    needsRetessellation = true;
                                }
                            }

                            if (needsRetessellation) {
                                this.updateStrokeBuffers(stroke, cameraFloor, cameraScale);
                            }

                            if (stroke.gpuData && stroke.gpuData.indexCount > 0) {
                                this.stencilRef = (this.stencilRef || 0) + 1;
                                if (this.stencilRef > 255) this.stencilRef = 1;
                                passEncoder.setStencilReference(this.stencilRef);

                                passEncoder.setVertexBuffer(0, stroke.gpuData.vertexBuffer);
                                passEncoder.setIndexBuffer(stroke.gpuData.indexBuffer, 'uint32');
                                passEncoder.drawIndexed(stroke.gpuData.indexCount, 1, 0, 0, 0);
                            }
                        });
                    }
                });
            }

            if (tempShape) {
                const floorDelta = (tempShape.floorIndex || 0) - cameraFloor.index;
                if (floorDelta <= 2) {
                    this.updateStrokeBuffers(tempShape as unknown as Stroke, cameraFloor, cameraScale);
                    if (tempShape.gpuData && tempShape.gpuData.indexCount > 0) {
                        this.stencilRef = (this.stencilRef || 0) + 1;
                        if (this.stencilRef > 255) this.stencilRef = 1;
                        passEncoder.setStencilReference(this.stencilRef);

                        passEncoder.setVertexBuffer(0, tempShape.gpuData.vertexBuffer);
                        passEncoder.setIndexBuffer(tempShape.gpuData.indexBuffer, 'uint32');
                        passEncoder.drawIndexed(tempShape.gpuData.indexCount, 1, 0, 0, 0);
                    }
                }
            }

            // --- Draw Overlays (already in camera's own coordinate space) ---
            // Overlays use a separate pipeline without stencil — no changes needed
            const overlayVertices: number[] = [];
            if (laserPoints) this.tessellateLaser(laserPoints, overlayVertices);
            if (lassoPoints) this.tessellateLasso(lassoPoints, overlayVertices);
            if (selectionBox) this.tessellateSelectionBox(selectionBox, overlayVertices);

            if (overlayVertices.length > 0) {
                const overlayVertexData = new Float32Array(overlayVertices);
                this.device.queue.writeBuffer(this.overlayVertexBuffer!, 0, overlayVertexData);

                passEncoder.setPipeline(this.overlayPipeline!);
                passEncoder.setBindGroup(0, this.viewBindGroup);
                passEncoder.setVertexBuffer(0, this.overlayVertexBuffer);
                passEncoder.draw(overlayVertices.length / 6, 1, 0, 0);
            }

            passEncoder.end();
            this.device.queue.submit([commandEncoder.finish()]);
        }
    }
    // --- END of WebGPURenderer ---