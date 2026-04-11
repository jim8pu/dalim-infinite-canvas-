document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    // --- SETUP & UTILS ---
    feather.replace();
    const $ = (selector) => document.querySelector(selector);
    const $$ = (selector) => document.querySelectorAll(selector);
    const ACCENT_BLUE = getComputedStyle(document.documentElement).getPropertyValue('--accent-blue').trim();
    const LASER_COLOR = getComputedStyle(document.documentElement).getPropertyValue('--laser-color').trim();
    const lerp = (a, b, t) => a + (b - a) * t;
    const getUniqueId = () => Date.now() + Math.random();

    // --- ZOOM FLOOR SYSTEM (Infinite Zoom) ---
    const FLOOR_BASE = 1000; // Zoom multiplier per floor

    class ZoomFloor {
        constructor(index, originInParent = { x: 0, y: 0 }, parent = null) {
            this.index = index;
            this.parent = parent;
            this.child = null;
            this.originInParent = { ...originInParent };
            this.BASE = FLOOR_BASE;
        }

        getOrCreateChild(originInParent) {
            if (!this.child) {
                this.child = new ZoomFloor(this.index + 1, originInParent, this);
            } else {
                // Check if any strokes exist on the child floor
                // If no strokes, re-center the child's origin
                if (!this.child._hasStrokes) {
                    this.child.originInParent = { ...originInParent };
                    this.child.child = null; // Reset deeper floors too
                }
            }
            return this.child;
        }

        toJSON() {
            return {
                index: this.index,
                originInParent: { ...this.originInParent },
                child: this.child ? this.child.toJSON() : null,
            };
        }

        static fromJSON(data, parent = null) {
            if (!data) return null;
            const floor = new ZoomFloor(data.index, data.originInParent, parent);
            if (data.child) {
                floor.child = ZoomFloor.fromJSON(data.child, floor);
            }
            return floor;
        }

        getRoot() {
            let f = this;
            while (f.parent) f = f.parent;
            return f;
        }

        getFloorByIndex(targetIndex) {
            let f = this.getRoot();
            if (targetIndex < f.index) return null;
            while (f && f.index < targetIndex) f = f.child;
            return (f && f.index === targetIndex) ? f : null;
        }
    }

    // Transforms a world point from its native floor to the target floor
    // Resolves coordinates continuously in Float64 precisely avoiding GPU matrix Float32 accuracy limits
    function transformPointToFloor(pt, srcFloorIndex, dstFloor) {
        let p = { x: pt.x, y: pt.y };
        let f = dstFloor.getRoot().getFloorByIndex(srcFloorIndex);
        if (!f) return p;

        if (srcFloorIndex < dstFloor.index) {
            // Walk down (zoom deeper)
            while (f && f.index < dstFloor.index && f.child) {
                f = f.child;
                p.x = (p.x - f.originInParent.x) * f.BASE;
                p.y = (p.y - f.originInParent.y) * f.BASE;
            }
        } else if (srcFloorIndex > dstFloor.index) {
            // Walk up (zoom out)
            while (f && f.index > dstFloor.index && f.parent) {
                p.x = p.x / f.BASE + f.originInParent.x;
                p.y = p.y / f.BASE + f.originInParent.y;
                f = f.parent;
            }
        }
        return p;
    }

    // Perform floor transition on both current and target view values
    function transitionFloor(viewState, direction) {
        const dpr = window.devicePixelRatio || 1;
        const canvas = $('#canvas');
        const w = canvas.width / dpr;
        const h = canvas.height / dpr;
        const screenCenterX = w / 2;
        const screenCenterY = h / 2;

        if (direction === 'up') {
            // Zoom IN: create/enter child floor
            // The child's origin = where we're looking in current floor coords
            const worldCenterX = (screenCenterX - viewState.panOffset.x) / viewState.scale;
            const worldCenterY = (screenCenterY - viewState.panOffset.y) / viewState.scale;

            const child = viewState.currentFloor.getOrCreateChild({ x: worldCenterX, y: worldCenterY });

            // Transform CURRENT values
            viewState.scale /= FLOOR_BASE;
            viewState.panOffset.x = screenCenterX; // Origin at center
            viewState.panOffset.y = screenCenterY;

            // Transform TARGET values
            const targetWorldCenterX = (screenCenterX - viewState.targetPanOffset.x) / viewState.targetScale;
            const targetWorldCenterY = (screenCenterY - viewState.targetPanOffset.y) / viewState.targetScale;
            const targetChildX = (targetWorldCenterX - worldCenterX) * FLOOR_BASE;
            const targetChildY = (targetWorldCenterY - worldCenterY) * FLOOR_BASE;
            viewState.targetScale /= FLOOR_BASE;
            viewState.targetPanOffset.x = screenCenterX - targetChildX * viewState.targetScale;
            viewState.targetPanOffset.y = screenCenterY - targetChildY * viewState.targetScale;

            viewState.currentFloor = child;
        } else if (direction === 'down' && viewState.currentFloor.parent) {
            // Zoom OUT: return to parent floor
            const origin = viewState.currentFloor.originInParent;

            // Transform CURRENT values
            const newScale = viewState.scale * FLOOR_BASE;
            viewState.panOffset.x = viewState.panOffset.x - origin.x * newScale;
            viewState.panOffset.y = viewState.panOffset.y - origin.y * newScale;
            viewState.scale = newScale;

            // Transform TARGET values
            const newTargetScale = viewState.targetScale * FLOOR_BASE;
            viewState.targetPanOffset.x = viewState.targetPanOffset.x - origin.x * newTargetScale;
            viewState.targetPanOffset.y = viewState.targetPanOffset.y - origin.y * newTargetScale;
            viewState.targetScale = newTargetScale;

            viewState.currentFloor = viewState.currentFloor.parent;
        }
    }

    // --- NEW: WebGPU Renderer Class ---
    class WebGPURenderer {
        constructor(canvas) {
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
            
            this.context.configure({
                device: this.device,
                format: this.presentationFormat,
                alphaMode: 'premultiplied',
            });

            this.createShaders();
            this.createBuffers();
            this.createPipelines();
        }

        // --- Utility to convert hex color to normalized RGBA array ---
        hexToRgba(hex, opacity = 1.0) {
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

            this.shaderModule = this.device.createShaderModule({ code: wgslCode });
        }

        createBuffers() {
            // --- Uniform Buffer ---
            this.viewUniformBuffer = this.device.createBuffer({
                size: 16 * 4, // 16 floats
                usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
            });
            
            // --- Overlay Vertex Buffer (Dynamic) ---
            // We keep this for UI elements that change every frame anyway
            this.overlayVertexBuffer = this.device.createBuffer({
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
            this.depthStencilTexture = this.device.createTexture({
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
            const vertexBufferLayout = {
                arrayStride: 6 * 4, // 6 floats * 4 bytes/float
                attributes: [
                    { shaderLocation: 0, offset: 0, format: 'float32x2' }, // position
                    { shaderLocation: 1, offset: 2 * 4, format: 'float32x4' }, // color
                ],
            };
            
            this.viewBindGroupLayout = this.device.createBindGroupLayout({
                entries: [{
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'uniform' },
                }]
            });
            
            this.viewBindGroup = this.device.createBindGroup({
                layout: this.viewBindGroupLayout,
                entries: [{
                    binding: 0,
                    resource: { buffer: this.viewUniformBuffer },
                }]
            });
            
            const pipelineLayout = this.device.createPipelineLayout({
                bindGroupLayouts: [this.viewBindGroupLayout]
            });

            const blendState = {
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
            this.pipeline = this.device.createRenderPipeline({
                layout: pipelineLayout,
                vertex: {
                    module: this.shaderModule,
                    entryPoint: 'vs_main',
                    buffers: [vertexBufferLayout],
                },
                fragment: {
                    module: this.shaderModule,
                    entryPoint: 'fs_main',
                    targets: [{ format: this.presentationFormat, blend: blendState }],
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
            this.overlayPipeline = this.device.createRenderPipeline({
                layout: pipelineLayout,
                vertex: {
                    module: this.shaderModule,
                    entryPoint: 'vs_main',
                    buffers: [vertexBufferLayout],
                },
                fragment: {
                    module: this.shaderModule,
                    entryPoint: 'fs_main',
                    targets: [{ format: this.presentationFormat, blend: blendState }],
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
        
        resize(width, height) {
            const dpr = window.devicePixelRatio || 1;
            this.canvas.width = Math.round(width * dpr);
            this.canvas.height = Math.round(height * dpr);
            this.canvas.style.width = `${width}px`;
            this.canvas.style.height = `${height}px`;
            // Recreate depth-stencil texture to match new canvas size
            if (this.device) {
                this._createDepthStencilTexture();
            }
        }

        // --- MODIFIED: Data-Returning Tessellators ---
        // These now return arrays instead of pushing to a global buffer

        // --- Catmull-Rom Spline Subdivision (Zoom-Aware + View-Frustum Culled) ---
        // screenScale: combined scale factor (cameraScale * floorEffScale) to convert world→screen px
        // viewRect: { minX, minY, maxX, maxY } visible world-space rectangle (null = subdivide all)
        // Target: each subdivided segment ≤ 3 screen pixels. Off-screen segments get 1 subdivision.
        catmullRomSubdivide(points, screenScale, viewRect) {
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

        tessellatePenStroke(stroke, cameraFloor, cameraScale) {
            const vertices = [];
            const indices = [];
            
            const points = stroke.points;
            if (points.length < 2) return { vertices, indices };

            const rawTransformed = points.map(pt => transformPointToFloor(pt, stroke.floorIndex, cameraFloor));

            const color = this.hexToRgba(stroke.color, (stroke.opacity / 100) * (stroke.isErasing ? 0.3 : 1.0));
            let effScale = 1;
            if (stroke.floorIndex < cameraFloor.index) {
                effScale = Math.pow(cameraFloor.BASE, cameraFloor.index - stroke.floorIndex);
            } else if (stroke.floorIndex > cameraFloor.index) {
                effScale = 1 / Math.pow(cameraFloor.BASE, stroke.floorIndex - cameraFloor.index);
            }
            const actualWidth = stroke.worldWidth !== undefined ? stroke.worldWidth : stroke.lineWidth;
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
        
        tessellateShape(shape, cameraFloor) {
            const vertices = [];
            const indices = [];
            const color = this.hexToRgba(shape.color, (shape.opacity / 100) * (shape.isErasing ? 0.3 : 1.0));
            let baseIndex = 0;

            const p1 = transformPointToFloor({x: shape.x, y: shape.y}, shape.floorIndex || 0, cameraFloor);
            const p2 = transformPointToFloor({x: shape.x + shape.width, y: shape.y + shape.height}, shape.floorIndex || 0, cameraFloor);

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
                    const cx = shape.x + shape.width / 2;
                    const cy = shape.y + shape.height / 2;
                    const rx = Math.abs(shape.width / 2);
                    const ry = Math.abs(shape.height / 2);
                    const segments = 32;
                    vertices.push(cx, cy, ...color);
                    baseIndex = 0; // Center is 0
                    for (let i = 0; i <= segments; i++) {
                        const angle = (i / segments) * 2 * Math.PI;
                        vertices.push(cx + Math.cos(angle) * rx, cy + Math.sin(angle) * ry, ...color);
                        if (i > 0) {
                            indices.push(0, i, i + 1);
                        }
                    }
                    break;
                case 'triangle':
                    vertices.push(shape.x + shape.width / 2, shape.y, ...color);
                    vertices.push(shape.x + shape.width, shape.y + shape.height, ...color);
                    vertices.push(shape.x, shape.y + shape.height, ...color);
                    indices.push(0, 1, 2);
                    break;
            }
            return { vertices, indices };
        }

        // --- Helper to upload a specific stroke to GPU ---
        updateStrokeBuffers(stroke, cameraFloor, cameraScale) {
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

            const vertexBuffer = this.device.createBuffer({
                size: (vertexByteLength + 3) & ~3,
                usage: GPUBufferUsage.VERTEX,
                mappedAtCreation: true,
            });
            new Float32Array(vertexBuffer.getMappedRange()).set(data.vertices);
            vertexBuffer.unmap();

            const indexBuffer = this.device.createBuffer({
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
        tessellateLasso(points, overlayVertices) {
            if (points.length < 2) return;
            const color = this.hexToRgba(ACCENT_BLUE, 0.8);
            for (let i = 0; i < points.length - 1; i++) {
                overlayVertices.push(points[i].x, points[i].y, ...color);
                overlayVertices.push(points[i+1].x, points[i+1].y, ...color);
            }
            overlayVertices.push(points[points.length - 1].x, points[points.length - 1].y, ...color);
            overlayVertices.push(points[0].x, points[0].y, ...color);
        }

        tessellateSelectionBox(box, overlayVertices) {
            const color = this.hexToRgba(ACCENT_BLUE, 1.0);
            const x = box.x, y = box.y, w = box.width, h = box.height;
            const p1 = [x, y]; const p2 = [x + w, y];
            const p3 = [x + w, y + h]; const p4 = [x, y + h];
            overlayVertices.push(...p1, ...color, ...p2, ...color);
            overlayVertices.push(...p2, ...color, ...p3, ...color);
            overlayVertices.push(...p3, ...color, ...p4, ...color);
            overlayVertices.push(...p4, ...color, ...p1, ...color);
        }

        tessellateLaser(points, overlayVertices) {
            if (points.length < 2) return;
            const color = this.hexToRgba(LASER_COLOR, 0.9);
            for (let i = 0; i < points.length - 1; i++) {
                overlayVertices.push(points[i].x, points[i].y, ...color);
                overlayVertices.push(points[i+1].x, points[i+1].y, ...color);
            }
        }

        // --- Build view-projection matrix from scale + pan ---
        buildMatrix(scale, panX, panY) {
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
        render(viewState, layers, laserPoints, lassoPoints, selectionBox, tempShape) {
            if (!this.device) return;

            const cameraFloor = viewState.currentFloor;
            const cameraScale = viewState.scale;
            const cameraPan = viewState.panOffset;

            // Store pan for use by tessellatePenStroke's view-rect computation
            this._lastPanX = cameraPan.x;
            this._lastPanY = cameraPan.y;
            
            const matrix = this.buildMatrix(cameraScale, cameraPan.x, cameraPan.y);
            this.device.queue.writeBuffer(this.viewUniformBuffer, 0, matrix);

            const commandEncoder = this.device.createCommandEncoder();
            const textureView = this.context.getCurrentTexture().createView();

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
                    view: this.depthStencilView,
                    depthLoadOp: 'clear',
                    depthClearValue: 1.0,
                    depthStoreOp: 'store',
                    stencilLoadOp: 'clear',
                    stencilClearValue: 0,
                    stencilStoreOp: 'store',
                },
            });

            passEncoder.setPipeline(this.pipeline);
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

                            if (!needsRetessellation && stroke.gpuData.tessellationScale) {
                                const zoomRatio = cameraScale / stroke.gpuData.tessellationScale;
                                if (zoomRatio > 1.5 || zoomRatio < (1 / 1.5)) {
                                    needsRetessellation = true;
                                }
                            }

                            if (needsRetessellation) {
                                this.updateStrokeBuffers(stroke, cameraFloor, cameraScale);
                            }

                            if (stroke.gpuData && stroke.gpuData.indexCount > 0) {
                                this.stencilRef++;
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
                    this.updateStrokeBuffers(tempShape, cameraFloor, cameraScale);
                    if (tempShape.gpuData && tempShape.gpuData.indexCount > 0) {
                        this.stencilRef++;
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
            const overlayVertices = [];
            if (laserPoints) this.tessellateLaser(laserPoints, overlayVertices);
            if (lassoPoints) this.tessellateLasso(lassoPoints, overlayVertices);
            if (selectionBox) this.tessellateSelectionBox(selectionBox, overlayVertices);

            if (overlayVertices.length > 0) {
                const overlayVertexData = new Float32Array(overlayVertices);
                this.device.queue.writeBuffer(this.overlayVertexBuffer, 0, overlayVertexData);

                passEncoder.setPipeline(this.overlayPipeline);
                passEncoder.setBindGroup(0, this.viewBindGroup);
                passEncoder.setVertexBuffer(0, this.overlayVertexBuffer);
                passEncoder.draw(overlayVertices.length / 6, 1, 0, 0);
            }

            passEncoder.end();
            this.device.queue.submit([commandEncoder.finish()]);
        }
    }
    // --- END of WebGPURenderer ---


    // --- DATA & STATE MANAGEMENT ---
    let appData = {};
    let sessionHistory = {}; 
    let currentOpenCardId = null;
    const defaultData = {
        revisions: {
            title: "Retrieval Scheduling",
            columns: [
                { id: getUniqueId(), title: 'Studying', cards: [] },
                { id: getUniqueId(), title: '1 Day Retrieval', cards: [] },
                { id: getUniqueId(), title: '1 Week Retrieval', cards: [] },
            ]
        }
    };

    function createDefaultCanvasState() {
        const firstLayerId = getUniqueId();
        return {
            layers: [{ id: firstLayerId, name: 'Layer 1', isVisible: true, strokes: [] }],
            activeLayerId: firstLayerId,
            panOffset: { x: 0, y: 0 }, 
            scale: 1,
            floorTree: new ZoomFloor(0).toJSON(),
            currentFloorIndex: 0
        };
    }

    function saveData() {
        try {
            // NOTE: We do NOT save 'gpuData' to localStorage. 
            // We use a replacer to strip it out, otherwise it saves as empty objects which causes errors on load.
            const replacer = (key, value) => {
                if (key === 'gpuData') return undefined;
                if (key === 'floor' && value instanceof ZoomFloor) return undefined;
                return value;
            };
            localStorage.setItem('advancedLearningAppData', JSON.stringify(appData, replacer));
        } catch (e) {
            console.error("An error occurred while saving data:", e);
            if (e.name === 'QuotaExceededError') {
                Modal.confirm('Storage Full', 'Could not save your latest changes because the browser storage is full.').then(() => {});
            }
        }
    }

    function loadData() {
        const savedData = localStorage.getItem('advancedLearningAppData');
        let parsedData;
        try {
            parsedData = savedData ? JSON.parse(savedData) : JSON.parse(JSON.stringify(defaultData));
        } catch (e) {
            console.error("Failed to parse saved data, resetting to default.", e);
            parsedData = JSON.parse(JSON.stringify(defaultData));
        }
        
        appData = { ...defaultData, ...parsedData };
        sessionHistory = {};
    
        if (!appData.revisions || !Array.isArray(appData.revisions.columns)) {
            appData.revisions = JSON.parse(JSON.stringify(defaultData.revisions));
        }
    
        appData.revisions.columns.forEach(col => {
            if (!Array.isArray(col.cards)) col.cards = [];
            col.cards.forEach(card => {
                if (!card.canvasState || typeof card.canvasState !== 'object') {
                    card.canvasState = createDefaultCanvasState();
                } else {
                    if (card.canvasState.strokes && !card.canvasState.layers) {
                        const firstLayerId = getUniqueId();
                        card.canvasState.layers = [{ id: firstLayerId, name: 'Layer 1', isVisible: true, strokes: card.canvasState.strokes || [] }];
                        card.canvasState.activeLayerId = firstLayerId;
                        delete card.canvasState.strokes;
                    }
                    
                    if (!Array.isArray(card.canvasState.layers)) {
                         card.canvasState.layers = [];
                    }
    
                    card.canvasState.layers.forEach(layer => {
                        if (!layer || typeof layer !== 'object') return;
                        if (!layer.id) layer.id = getUniqueId();
                        if (typeof layer.name !== 'string') layer.name = 'Layer';
                        if (typeof layer.isVisible !== 'boolean') layer.isVisible = true;
                        if (!Array.isArray(layer.strokes)) layer.strokes = [];
                        layer.strokes = layer.strokes.filter(stroke => stroke && typeof stroke === 'object' && stroke.type);
                    });
    
                    if (card.canvasState.layers.length === 0) {
                         const firstLayerId = getUniqueId();
                         card.canvasState.layers.push({ id: firstLayerId, name: 'Layer 1', isVisible: true, strokes: [] });
                         card.canvasState.activeLayerId = firstLayerId;
                    } else if (!card.canvasState.activeLayerId || !card.canvasState.layers.some(l => l.id === card.canvasState.activeLayerId)) {
                        card.canvasState.activeLayerId = card.canvasState.layers[0].id;
                    }
                }
                sessionHistory[card.id] = { history: [], historyIndex: -1 };
            });
        });
    }

    // --- VIEW SWITCHING ---
    function switchView(viewName) {
        $$('.view').forEach(view => view.classList.remove('active'));
        $(`#${viewName}-view`).classList.add('active');
        if (viewName === 'canvas') { 
            initCanvas(); 
        } 
        else { currentOpenCardId = null; renderRevisionsBoard(); }
    }
    
    // --- CUSTOM MODAL LOGIC ---
    const Modal = {
        _resolve: null,
        overlay: $('#custom-modal'),
        titleEl: $('#modal-title'),
        bodyEl: $('#modal-body'),
        actionsEl: $('#modal-actions'),
        confirm(title, message) {
            return new Promise(resolve => {
                this._resolve = resolve;
                this.titleEl.textContent = title;
                this.bodyEl.innerHTML = `<p>${message}</p>`;
                this.actionsEl.innerHTML = `
                    <button class="modal-btn modal-btn-secondary" data-value="false">Cancel</button>
                    <button class="modal-btn modal-btn-danger" data-value="true">Confirm</button>
                `;
                this._show();
            });
        },
        prompt(title, defaultValue = '') {
            return new Promise(resolve => {
                this._resolve = resolve;
                this.titleEl.textContent = title;
                this.bodyEl.innerHTML = `<input type="text" id="modal-input" class="modal-input" value="${defaultValue}">`;
                this.actionsEl.innerHTML = `
                    <button class="modal-btn modal-btn-secondary" data-value="null">Cancel</button>
                    <button class="modal-btn modal-btn-primary" data-value="submit">OK</button>
                `;
                this._show();
                setTimeout(() => $('#modal-input').focus(), 50);
            });
        },
        _show() { this.overlay.classList.add('visible'); this.overlay.onclick = this._handleClick.bind(this); },
        _hide() { this.overlay.classList.remove('visible'); this.overlay.onclick = null; },
        _handleClick(e) {
            const target = e.target;
            const button = target.closest('.modal-btn');
            if (target === this.overlay) { this._resolve(null); this._hide(); }
            else if (button) {
                const value = button.dataset.value;
                if (value === 'null') this._resolve(null);
                else if (value === 'submit') this._resolve($('#modal-input').value);
                else this._resolve(value === 'true');
                this._hide();
            }
        }
    };

    // --- KANBAN BOARD LOGIC --- (Unchanged)
    function renderRevisionsBoard() {
        const view = $('#revisions-view');
        const scrollLeft = view.querySelector('.board-columns')?.scrollLeft;
        
        view.innerHTML = `
            <div class="board-view">
                <div class="board-header">
                    <h1>${appData.revisions.title}</h1>
                    <button class="add-column-btn">+ Add Column</button>
                </div>
                <div class="board-columns">
                    ${appData.revisions.columns.map(col => `
                        <div class="board-column" data-col-id="${col.id}">
                            <div class="column-header">
                                <span class="column-title">${col.title}</span>
                                <div class="column-actions-menu">
                                    <button class="column-menu-btn"><i data-feather="more-horizontal"></i></button>
                                    <div class="column-menu-popup">
                                        <button class="action-btn rename-column-btn"><i data-feather="edit-2"></i>Rename</button>
                                        <button class="action-btn delete-column-btn"><i data-feather="trash"></i>Delete</button>
                                    </div>
                                </div>
                            </div>
                            <div class="column-cards">${col.cards.map(renderCard).join('')}</div>
                            <div class="column-footer" data-col-id="${col.id}">+ Create Canvas</div>
                        </div>
                    `).join('')}
                </div>
            </div>`;
        
        if (scrollLeft) view.querySelector('.board-columns').scrollLeft = scrollLeft;

        addBoardEventListeners();
        feather.replace();
    }

    function renderCard(card) {
        return `<div class="card" data-card-id="${card.id}">
                    <h3>${card.title}</h3>
                    <div class="card-actions">
                        <div class="action-btn open-canvas" title="Open in Canvas"><i data-feather="arrow-up-right"></i></div>
                        <div class="action-btn rename-card" title="Rename Card"><i data-feather="edit-2"></i></div>
                        <div class="action-btn delete-card" title="Delete Card"><i data-feather="x"></i></div>
                    </div>
                </div>`;
    }

    function addBoardEventListeners() {
        const view = $('#revisions-view');
        if (view.dataset.listenersAttached) return;

        let dragState = {};

        view.addEventListener('click', async (e) => {
            const menuBtn = e.target.closest('.column-menu-btn');
            if (menuBtn) {
                const popup = menuBtn.nextElementSibling;
                const isVisible = popup.classList.contains('visible');
                $$('.column-menu-popup').forEach(p => p.classList.remove('visible'));
                if (!isVisible) popup.classList.add('visible');
                return;
            }
            if (!e.target.closest('.column-menu-popup')) {
                 $$('.column-menu-popup').forEach(p => p.classList.remove('visible'));
            }
            
            const cardElement = e.target.closest('.card');
            if (cardElement && !e.target.closest('.action-btn')) {
                const isShowing = cardElement.classList.contains('show-actions');
                $$('.card.show-actions').forEach(c => c.classList.remove('show-actions'));
                if (!isShowing) cardElement.classList.add('show-actions');
                return; 
            }
            if (!cardElement) {
                $$('.card.show-actions').forEach(c => c.classList.remove('show-actions'));
            }

            const addColumnBtn = e.target.closest('.add-column-btn');
            const deleteColumnBtn = e.target.closest('.delete-column-btn');
            const renameColumnBtn = e.target.closest('.rename-column-btn');
            const columnFooter = e.target.closest('.column-footer');
            const deleteCardBtn = e.target.closest('.delete-card');
            const renameCardBtn = e.target.closest('.rename-card');
            const openCanvasBtn = e.target.closest('.open-canvas');

            if (addColumnBtn) {
                const title = await Modal.prompt('Enter new column name:');
                if (title?.trim()) {
                    appData.revisions.columns.push({ id: getUniqueId(), title: title.trim(), cards: [] });
                    saveData(); renderRevisionsBoard();
                }
            } else if (deleteColumnBtn) {
                const colId = parseFloat(deleteColumnBtn.closest('.board-column').dataset.colId);
                const column = appData.revisions.columns.find(c => c.id === colId);
                if (await Modal.confirm('Delete Column?', `Are you sure you want to delete "${column.title}" and all its cards?`)) {
                    appData.revisions.columns = appData.revisions.columns.filter(c => c.id !== colId);
                    saveData(); renderRevisionsBoard();
                }
            } else if (renameColumnBtn) {
                const colId = parseFloat(renameColumnBtn.closest('.board-column').dataset.colId);
                const column = appData.revisions.columns.find(c => c.id === colId);
                const newTitle = await Modal.prompt('Enter new column name:', column.title);
                if (newTitle?.trim()) {
                    column.title = newTitle.trim();
                    saveData(); renderRevisionsBoard();
                }
            } else if (columnFooter) {
                const title = await Modal.prompt('Enter card name:');
                if (title?.trim()) {
                    const colId = parseFloat(columnFooter.dataset.colId);
                    const column = appData.revisions.columns.find(c => c.id === colId);
                    if (column) {
                        const newCard = { id: getUniqueId(), title: title.trim(), canvasState: createDefaultCanvasState() };
                        column.cards.push(newCard);
                        sessionHistory[newCard.id] = { history: [], historyIndex: -1 };
                        saveData(); renderRevisionsBoard();
                    }
                }
            } else if (deleteCardBtn) {
                 if (await Modal.confirm('Delete Card?', 'This action cannot be undone.')) {
                    const cardId = parseFloat(deleteCardBtn.closest('.card').dataset.cardId);
                    appData.revisions.columns.forEach(c => { c.cards = c.cards.filter(card => card.id !== cardId) });
                    delete sessionHistory[cardId];
                    saveData(); renderRevisionsBoard();
                }
            } else if (renameCardBtn) {
                const cardId = parseFloat(renameCardBtn.closest('.card').dataset.cardId);
                const { card } = findCardById(cardId);
                const newTitle = await Modal.prompt('Enter new card name:', card.title);
                if (newTitle?.trim()) {
                    card.title = newTitle.trim();
                    saveData(); renderRevisionsBoard();
                }
            } else if (openCanvasBtn) {
                currentOpenCardId = parseFloat(openCanvasBtn.closest('.card').dataset.cardId);
                switchView('canvas');
            }
        });
        const startDrag = (e) => {
            if (e.target.closest('.action-btn') || e.target.closest('.column-menu-btn')) return;
            const isTouchEvent = e.type === 'touchstart';
            const point = isTouchEvent ? e.touches[0] : e;
            const targetCard = point.target.closest('.card');
            const targetColumnHeader = point.target.closest('.column-header');
            if (!targetCard && !targetColumnHeader) return;
            dragState.element = targetCard || targetColumnHeader.closest('.board-column');
            dragState.type = targetCard ? 'card' : 'column';
            const startAction = () => {
                const rect = dragState.element.getBoundingClientRect();
                if (dragState.type === 'card') {
                    dragState.offsetX = point.clientX - rect.left;
                    dragState.offsetY = point.clientY - rect.top;
                    dragState.ghost = dragState.element.cloneNode(true);
                    dragState.ghost.style.height = `${rect.height}px`;
                } else {
                    const header = dragState.element.querySelector('.column-header');
                    const headerRect = header.getBoundingClientRect();
                    dragState.offsetX = point.clientX - headerRect.left;
                    dragState.offsetY = point.clientY - headerRect.top;
                    dragState.ghost = header.cloneNode(true);
                }
                dragState.ghost.classList.add('ghost');
                dragState.ghost.style.width = `${rect.width}px`;
                document.body.appendChild(dragState.ghost);
                moveDrag(e);
                dragState.element.classList.add(dragState.type === 'card' ? 'is-dragging' : 'is-dragging-column');
                if (isTouchEvent) {
                    window.addEventListener('touchmove', moveDrag, { passive: false });
                    window.addEventListener('touchend', endDrag);
                    window.addEventListener('touchcancel', endDrag);
                } else {
                    window.addEventListener('mousemove', moveDrag);
                    window.addEventListener('mouseup', endDrag);
                }
            };
            if (isTouchEvent) {
                dragState.longPressTimeout = setTimeout(startAction, 200);
            } else { e.preventDefault(); startAction(); }
        };
        const moveDrag = (e) => {
            if (!dragState.ghost) return;
            e.preventDefault();
            const isTouchEvent = e.type.includes('touch');
            const point = isTouchEvent ? e.touches[0] : e;
            dragState.ghost.style.left = `${point.clientX - dragState.offsetX}px`;
            if (dragState.type === 'card') {
                dragState.ghost.style.top = `${point.clientY - dragState.offsetY}px`;
            } else {
                 const headerRect = dragState.element.querySelector('.column-header').getBoundingClientRect();
                 dragState.ghost.style.top = `${headerRect.top}px`;
            }
            dragState.ghost.style.visibility = 'hidden';
            const elementUnder = document.elementFromPoint(point.clientX, point.clientY);
            dragState.ghost.style.visibility = 'visible';
            $('.card-placeholder')?.remove();
            if (dragState.type === 'card') {
                const cardList = elementUnder?.closest('.column-cards');
                if (cardList) {
                    const placeholder = document.createElement('div');
                    placeholder.className = 'card-placeholder';
                    const afterElement = getDragAfterElement(cardList, point.clientY, '.card:not(.is-dragging)');
                    cardList.insertBefore(placeholder, afterElement);
                }
            } else if (dragState.type === 'column') {
                const columnList = dragState.element.parentElement;
                const afterElement = getDragAfterElement(columnList, point.clientX, '.board-column:not(.is-dragging-column)');
                columnList.insertBefore(dragState.element, afterElement);
            }
        };
        const endDrag = () => {
            clearTimeout(dragState.longPressTimeout);
            if (!dragState.element) return;

            dragState.ghost?.remove();
            const placeholder = $('.card-placeholder');

            if (dragState.type === 'column') {
                const newOrderedColumns = [];
                const columnList = dragState.element.parentElement;
                if (columnList) {
                    columnList.querySelectorAll('.board-column').forEach(c => {
                        const colId = parseFloat(c.dataset.colId);
                        const foundCol = appData.revisions.columns.find(col => col.id === colId);
                        if (foundCol) newOrderedColumns.push(foundCol);
                    });
                    appData.revisions.columns = newOrderedColumns;
                }
            } else if (placeholder && placeholder.parentElement) { // Card logic
                const cardId = parseFloat(dragState.element.dataset.cardId);
                const targetColId = parseFloat(placeholder.closest('.board-column').dataset.colId);
                const { card: cardData, fromColumn } = findCardById(cardId);
                const targetCol = appData.revisions.columns.find(c => c.id === targetColId);

                if (cardData && targetCol && fromColumn) {
                    fromColumn.cards = fromColumn.cards.filter(c => c.id !== cardId);
                    const newIndex = Array.from(placeholder.parentElement.children).indexOf(placeholder);
                    targetCol.cards.splice(newIndex, 0, cardData);
                }
            }
            
            saveData();
            renderRevisionsBoard();

            dragState = {};
            window.removeEventListener('mousemove', moveDrag);
            window.removeEventListener('mouseup', endDrag);
            window.removeEventListener('touchmove', moveDrag, { passive: false });
            window.removeEventListener('touchend', endDrag);
            window.removeEventListener('touchcancel', endDrag);
        };


        view.addEventListener('mousedown', startDrag);
        view.addEventListener('touchstart', startDrag, { passive: true });
        view.addEventListener('touchend', () => clearTimeout(dragState.longPressTimeout));
        view.addEventListener('touchcancel', () => clearTimeout(dragState.longPressTimeout));

        view.dataset.listenersAttached = 'true';
    }

    function findCardById(cardId) {
        for (const col of appData.revisions.columns) {
            const card = col.cards.find(c => c.id === cardId);
            if (card) return { card, fromColumn: col };
        }
        return { card: null, fromColumn: null };
    }

    function getDragAfterElement(container, coordinate, selector) {
        const isHorizontal = container.classList.contains('board-columns');
        const draggableElements = [...container.querySelectorAll(selector)];
        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = isHorizontal ? coordinate - box.left - box.width / 2 : coordinate - box.top - box.height / 2;
            if (offset < 0 && offset > closest.offset) return { offset, element: child };
            return closest;
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    // --- CANVAS LOGIC ---
    const canvas = $('#canvas');
    let renderer = null;
    const selectionToolbar = $('#selection-toolbar');
    
    let brushSettings = {
        pen:         { color: '#F8FAFC', lineWidth: 5, opacity: 100, smoothness: 50 },
        highlighter: { color: '#FBBF24', lineWidth: 25, opacity: 30, smoothness: 70 },
        laser:       { color: '#F43F5E', lineWidth: 5, opacity: 100, smoothness: 90 },
        rectangle:   { color: '#F8FAFC', lineWidth: 4, opacity: 100, smoothness: 100 },
        circle:      { color: '#F8FAFC', lineWidth: 4, opacity: 100, smoothness: 100 },
        triangle:    { color: '#F8FAFC', lineWidth: 4, opacity: 100, smoothness: 100 },
        eraser:      { lineWidth: 20 },
    };

    let canvasState = {
        isDrawing: false, isPanning: false, isLassoing: false,
        isMovingSelection: false, isResizingSelection: false,
        lastPos: { x: 0, y: 0 }, panStart: { x: 0, y: 0 },
        activeTool: 'pen',
        lassoPoints: [],
        laserPoints: [],
        selectedStrokes: new Set(),
        selectionBox: null,
        resizeHandle: null,
        tempShape: null,
        activeSettingWedge: null,
    };
    
    let viewState = {
        scale: 1, panOffset: { x: 0, y: 0 },
        targetScale: 1, targetPanOffset: { x: 0, y: 0 },
        currentFloor: new ZoomFloor(0),
    };
    
    const activePointers = new Map();
    let redrawRequested = false;
    let pinchState = { startDistance: null };

    // --- CANVAS HELPERS ---
    function getActiveCardCanvasState() {
        if (!currentOpenCardId) return null;
        const { card } = findCardById(currentOpenCardId);
        return card ? card.canvasState : null;
    }

    function getActiveLayer() {
        const canvasData = getActiveCardCanvasState();
        if (!canvasData || !canvasData.layers) return null;
        return canvasData.layers.find(l => l.id === canvasData.activeLayerId);
    }
    
    function findStrokeAndLayer(strokeId) {
        const canvasData = getActiveCardCanvasState();
        if (!canvasData) return { stroke: null, layer: null };
        for (const layer of canvasData.layers) {
            const stroke = layer.strokes.find(s => s.id === strokeId);
            if (stroke) return { stroke, layer };
        }
        return { stroke: null, layer: null };
    }

    // --- CANVAS HISTORY (UNDO/REDO) ---
    let preModificationStrokes = null;

    function getActiveCardHistory() {
        return (currentOpenCardId && sessionHistory[currentOpenCardId]) ? sessionHistory[currentOpenCardId] : null;
    }

    function storePreModificationState() {
        const activeLayer = getActiveLayer(); if (!activeLayer) return;
        if (canvasState.selectedStrokes.size > 0) {
            preModificationStrokes = JSON.parse(JSON.stringify(
                activeLayer.strokes.filter(s => canvasState.selectedStrokes.has(s.id))
            ));
        } else {
            preModificationStrokes = null;
        }
    }
    
    function addHistoryAction(action) {
        const cardHistory = getActiveCardHistory(); if (!cardHistory) return;
        cardHistory.history.splice(cardHistory.historyIndex + 1);
        cardHistory.history.push(action);
        cardHistory.historyIndex++;
        if (cardHistory.history.length > 100) {
            cardHistory.history.shift();
            cardHistory.historyIndex--;
        }
    }

    function undo() {
        const canvasData = getActiveCardCanvasState();
        const cardHistory = getActiveCardHistory();
        if (!canvasData || !cardHistory || cardHistory.historyIndex < 0) return;

        const actionToUndo = cardHistory.history[cardHistory.historyIndex];
        const layer = canvasData.layers.find(l => l.id === actionToUndo.layerId);
        if (!layer) return;

        switch (actionToUndo.type) {
            case 'ADD':
                const addedIds = new Set(actionToUndo.strokes.map(s => s.id));
                // Dispose GPU buffers for removed strokes
                layer.strokes.forEach(s => { if(addedIds.has(s.id) && s.gpuData) { s.gpuData.vertexBuffer.destroy(); s.gpuData.indexBuffer.destroy(); } });
                layer.strokes = layer.strokes.filter(s => !addedIds.has(s.id));
                break;
            case 'REMOVE':
                // Restored strokes come from JSON, so gpuData is naturally null/undefined. Perfect.
                layer.strokes.push(...JSON.parse(JSON.stringify(actionToUndo.strokes)));
                break;
            case 'MODIFY':
                const modifiedIds = new Set(actionToUndo.before.map(s => s.id));
                // Clean up modified strokes
                layer.strokes.forEach(s => { if(modifiedIds.has(s.id) && s.gpuData) { s.gpuData.vertexBuffer.destroy(); s.gpuData.indexBuffer.destroy(); } });
                layer.strokes = layer.strokes.filter(s => !modifiedIds.has(s.id));
                layer.strokes.push(...JSON.parse(JSON.stringify(actionToUndo.before)));
                break;
        }

        cardHistory.historyIndex--;
        canvasState.selectedStrokes.clear();
        canvasState.selectionBox = null;
        hideSelectionToolbar();
        redrawRequested = true;
    }

    function redo() {
        const canvasData = getActiveCardCanvasState();
        const cardHistory = getActiveCardHistory();
        if (!canvasData || !cardHistory || cardHistory.historyIndex >= cardHistory.history.length - 1) return;

        const actionToRedo = cardHistory.history[cardHistory.historyIndex + 1];
        const layer = canvasData.layers.find(l => l.id === actionToRedo.layerId);
        if (!layer) return;

        switch (actionToRedo.type) {
            case 'ADD':
                layer.strokes.push(...JSON.parse(JSON.stringify(actionToRedo.strokes)));
                break;
            case 'REMOVE':
                const removedIds = new Set(actionToRedo.strokes.map(s => s.id));
                layer.strokes.forEach(s => { if(removedIds.has(s.id) && s.gpuData) { s.gpuData.vertexBuffer.destroy(); s.gpuData.indexBuffer.destroy(); } });
                layer.strokes = layer.strokes.filter(s => !removedIds.has(s.id));
                break;
            case 'MODIFY':
                const modifiedIds = new Set(actionToRedo.after.map(s => s.id));
                layer.strokes.forEach(s => { if(modifiedIds.has(s.id) && s.gpuData) { s.gpuData.vertexBuffer.destroy(); s.gpuData.indexBuffer.destroy(); } });
                layer.strokes = layer.strokes.filter(s => !modifiedIds.has(s.id));
                layer.strokes.push(...JSON.parse(JSON.stringify(actionToRedo.after)));
                break;
        }

        cardHistory.historyIndex++;
        canvasState.selectedStrokes.clear();
        canvasState.selectionBox = null;
        hideSelectionToolbar();
        redrawRequested = true;
    }

    function getCanvasPos(e) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left - viewState.panOffset.x) / viewState.scale,
            y: (e.clientY - rect.top - viewState.panOffset.y) / viewState.scale
        };
    }

    function handleCanvasPointerDown(e) {
        const activeLayer = getActiveLayer();
        if (!activeLayer) return;
        
        activePointers.set(e.pointerId, e);
        if (activePointers.size === 2) {
            canvasState.isDrawing = false;
            const pointers = Array.from(activePointers.values());
            pinchState.startDistance = Math.hypot(pointers[0].clientX - pointers[1].clientX, pointers[0].clientY - pointers[1].clientY);
            return;
        }
        if (activePointers.size > 2) return;

        canvasState.lastPos = getCanvasPos(e);
        canvasState.panStart = { x: e.clientX, y: e.clientY };

        if (canvasState.activeTool === 'pan' || e.button === 2 || (e.button === 0 && e.altKey)) {
            canvasState.isPanning = true;
            canvas.style.cursor = 'grabbing';
            return;
        }
        
        if (e.button === 1) {
            e.preventDefault();
            setActiveTool('lasso');
            canvasState.isLassoing = true;
            canvasState.lassoPoints = [canvasState.lastPos];
            return;
        }
        
        if (e.button === 0) {
            if (canvasState.selectionBox) {
                const handle = getResizeHandleUnderCursor(canvasState.lastPos);
                if (handle) {
                    canvasState.isResizingSelection = true;
                    canvasState.resizeHandle = handle;
                    storePreModificationState();
                    return;
                }
                if (isPointInBox(canvasState.lastPos, canvasState.selectionBox)) {
                    canvasState.isMovingSelection = true;
                    storePreModificationState();
                    return;
                }
            }
            
            canvasState.selectedStrokes.clear();
            canvasState.selectionBox = null;
            hideSelectionToolbar();
            canvasState.isDrawing = true;
            
            const currentBrush = brushSettings[canvasState.activeTool] || {};
            const options = { id: getUniqueId(), ...currentBrush };
            
            switch (canvasState.activeTool) {
                case 'pen': case 'highlighter':
                    const newStroke = { ...options, type: canvasState.activeTool, floorIndex: viewState.currentFloor.index, worldWidth: options.lineWidth / viewState.scale, points: [canvasState.lastPos], rawPoints: [canvasState.lastPos] };
                    activeLayer.strokes.push(newStroke);
                    break;
                case 'rectangle': case 'circle': case 'triangle':
                    canvasState.tempShape = { ...options, type: canvasState.activeTool, floorIndex: viewState.currentFloor.index, x: canvasState.lastPos.x, y: canvasState.lastPos.y, width: 0, height: 0 };
                    break;
                case 'eraser':
                    eraseAt(canvasState.lastPos);
                    break;
                case 'lasso':
                    canvasState.isLassoing = true;
                    canvasState.lassoPoints = [canvasState.lastPos];
                    break;
                case 'laser':
                    canvasState.laserPoints.push({ x: canvasState.lastPos.x, y: canvasState.lastPos.y, time: Date.now() });
                    break;
            }
        }
        redrawRequested = true;
    }

    function handleCanvasPointerMove(e) {
        if (!activePointers.has(e.pointerId)) return;
        activePointers.set(e.pointerId, e);

        if (activePointers.size === 2) {
            const pointers = Array.from(activePointers.values());
            const p1 = pointers[0], p2 = pointers[1];
            const newDist = Math.hypot(p1.clientX - p2.clientX, p1.clientY - p2.clientY);
            if (pinchState.startDistance === null) { pinchState.startDistance = newDist; return; }
            const rect = canvas.getBoundingClientRect();
            const center = { x: (p1.clientX + p2.clientX) / 2 - rect.left, y: (p1.clientY + p2.clientY) / 2 - rect.top };
            const scaleMultiplier = newDist / pinchState.startDistance;
            const oldScale = viewState.targetScale;
            const newTargetScale = Math.max(0.01, oldScale * scaleMultiplier);
            const worldPos = { x: (center.x - viewState.targetPanOffset.x) / oldScale, y: (center.y - viewState.targetPanOffset.y) / oldScale };
            viewState.targetPanOffset = { x: center.x - worldPos.x * newTargetScale, y: center.y - worldPos.y * newTargetScale };
            viewState.targetScale = newTargetScale;
            checkFloorTransitions();
            pinchState.startDistance = newDist;
            redrawRequested = true;
            return;
        }

        if (activePointers.size !== 1) return;

        const pos = getCanvasPos(e);
        const activeLayer = getActiveLayer();
        
        const dx = pos.x - canvasState.lastPos.x;
        const dy = pos.y - canvasState.lastPos.y;
        canvasState.lastPos = pos;

        if (canvasState.isPanning) {
            viewState.targetPanOffset.x += e.clientX - canvasState.panStart.x;
            viewState.targetPanOffset.y += e.clientY - canvasState.panStart.y;
            canvasState.panStart = { x: e.clientX, y: e.clientY };
        } else if (canvasState.isResizingSelection) {
            resizeSelection(dx, dy);
        } else if (canvasState.isMovingSelection) {
            moveSelection(dx, dy);
        } else if (canvasState.isLassoing) {
            canvasState.lassoPoints.push(pos);
        } else if (canvasState.isDrawing && activeLayer) {
            switch (canvasState.activeTool) {
                case 'pen': case 'highlighter':
                    const currentStroke = activeLayer.strokes[activeLayer.strokes.length - 1];
                    if (currentStroke) {
                        currentStroke.rawPoints.push(pos);
                        const settings = brushSettings[canvasState.activeTool];
                        currentStroke.points = (settings.smoothness > 1) ? applySmoothing(currentStroke.rawPoints, settings.smoothness) : [...currentStroke.rawPoints];
                        // Force re-tessellation for active stroke
                        currentStroke.gpuData = null; 
                    }
                    break;
                case 'rectangle': case 'circle': case 'triangle':
                    canvasState.tempShape.width = pos.x - canvasState.tempShape.x;
                    canvasState.tempShape.height = pos.y - canvasState.tempShape.y;
                    break;
                case 'eraser':
                    eraseAt(pos);
                    break;
                case 'laser':
                    canvasState.laserPoints.push({ x: pos.x, y: pos.y, time: Date.now() });
                    break;
            }
        }
        redrawRequested = true;
    }
    
    function handleCanvasPointerUp(e) {
        activePointers.delete(e.pointerId);
        if (activePointers.size < 2) pinchState.startDistance = null;
        if (activePointers.size > 0) return;

        if (canvasState.isPanning) {
            const canvasData = getActiveCardCanvasState();
            if (canvasData) {
                canvasData.panOffset = { ...viewState.panOffset };
                canvasData.scale = viewState.scale;
                canvasData.floorTree = viewState.currentFloor.getRoot().toJSON();
                canvasData.currentFloorIndex = viewState.currentFloor.index;
                saveData();
            }
        }

        const activeLayer = getActiveLayer();
        if (!activeLayer) {
            canvasState.isDrawing = canvasState.isPanning = canvasState.isLassoing = false;
            canvasState.isMovingSelection = canvasState.isResizingSelection = false;
            updateCursor();
            return;
        }

        // --- HANDLE HISTORY ACTIONS ---
        if (canvasState.activeTool === 'eraser') {
            const erasedStrokes = activeLayer.strokes.filter(s => s.isErasing);
            if (erasedStrokes.length > 0) {
                const erasedStrokesCopy = JSON.parse(JSON.stringify(erasedStrokes.map(s => { delete s.isErasing; return s; })));
                activeLayer.strokes = activeLayer.strokes.filter(s => !s.isErasing);
                // Dispose GPU buffers
                erasedStrokes.forEach(s => { if(s.gpuData) { s.gpuData.vertexBuffer.destroy(); s.gpuData.indexBuffer.destroy(); } });
                
                addHistoryAction({ type: 'REMOVE', strokes: erasedStrokesCopy, layerId: activeLayer.id });
                saveData();
            }
        }
        activeLayer.strokes.forEach(s => delete s.isErasing);

        if (canvasState.isDrawing && canvasState.tempShape) {
            if (Math.abs(canvasState.tempShape.width) > 2 || Math.abs(canvasState.tempShape.height) > 2) {
                const shapeToAdd = JSON.parse(JSON.stringify(canvasState.tempShape));
                activeLayer.strokes.push(shapeToAdd);
                addHistoryAction({ type: 'ADD', strokes: [shapeToAdd], layerId: activeLayer.id });
                saveData();
            }
            // Cleanup temp shape buffer
            if(canvasState.tempShape.gpuData) {
                canvasState.tempShape.gpuData.vertexBuffer.destroy();
                canvasState.tempShape.gpuData.indexBuffer.destroy();
            }
            canvasState.tempShape = null;
        }

        if (canvasState.isDrawing && (canvasState.activeTool === 'pen' || canvasState.activeTool === 'highlighter')) {
            const currentStroke = activeLayer.strokes[activeLayer.strokes.length - 1];
            if (currentStroke) {
                const strokeForHistory = JSON.parse(JSON.stringify(currentStroke));
                delete strokeForHistory.rawPoints;
                addHistoryAction({ type: 'ADD', strokes: [strokeForHistory], layerId: activeLayer.id });
                delete currentStroke.rawPoints;
                saveData();
            }
        }
        
        if (canvasState.isLassoing) selectStrokesInLasso();

        if ((canvasState.isMovingSelection || canvasState.isResizingSelection) && preModificationStrokes) {
            const postModificationStrokes = JSON.parse(JSON.stringify(
                activeLayer.strokes.filter(s => canvasState.selectedStrokes.has(s.id))
            ));
            if (JSON.stringify(preModificationStrokes) !== JSON.stringify(postModificationStrokes)) {
                addHistoryAction({ type: 'MODIFY', before: preModificationStrokes, after: postModificationStrokes, layerId: activeLayer.id });
                saveData();
            }
            preModificationStrokes = null;
        }

        // --- RESET CANVAS STATE ---
        canvasState.isDrawing = canvasState.isPanning = canvasState.isLassoing = false;
        canvasState.isMovingSelection = canvasState.isResizingSelection = false;
        canvasState.resizeHandle = null;
        updateCursor();
        redrawRequested = true;
    }
    
    function handleWheel(e) {
        e.preventDefault();
        if (canvasState.isDrawing || canvasState.isMovingSelection || canvasState.isResizingSelection) return;

        if (e.ctrlKey) { // Zooming
            const rect = canvas.getBoundingClientRect();
            const zoomIntensity = 0.005;
            const zoomFactor = Math.exp(-e.deltaY * zoomIntensity);
            const mousePoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            const oldScale = viewState.targetScale;
            const newTargetScale = Math.max(0.01, oldScale * zoomFactor);
            const worldPos = { x: (mousePoint.x - viewState.targetPanOffset.x) / oldScale, y: (mousePoint.y - viewState.targetPanOffset.y) / oldScale };
            viewState.targetPanOffset = { x: mousePoint.x - worldPos.x * newTargetScale, y: mousePoint.y - worldPos.y * newTargetScale };
            viewState.targetScale = newTargetScale;

            // --- FLOOR TRANSITIONS ---
            checkFloorTransitions();
        } else { // Panning
            viewState.targetPanOffset.x -= e.deltaX;
            viewState.targetPanOffset.y -= e.deltaY;
        }
        redrawRequested = true;
    }

    function checkFloorTransitions() {
        // Zoom IN: target crossed FLOOR_BASE threshold
        while (viewState.targetScale >= FLOOR_BASE) {
            transitionFloor(viewState, 'up');
        }
        // Zoom OUT: target dropped below 1.0 and parent exists
        while (viewState.targetScale < 1.0 && viewState.currentFloor.parent) {
            transitionFloor(viewState, 'down');
        }
        // Clamp minimum zoom at root floor
        if (!viewState.currentFloor.parent) {
            viewState.targetScale = Math.max(0.01, viewState.targetScale);
        }
    }

    function eraseAt(pos) {
        const activeLayer = getActiveLayer(); if (!activeLayer) return;
        const eraseRadius = brushSettings.eraser.lineWidth / 2;
        let changed = false;
        activeLayer.strokes.forEach(stroke => {
            const box = getStrokeBounds(stroke);
            if (pos.x < box.minX - eraseRadius || pos.x > box.maxX + eraseRadius || pos.y < box.minY - eraseRadius || pos.y > box.maxY + eraseRadius) return;
            
            const wasErasing = stroke.isErasing;
            stroke.isErasing = false;
            if (stroke.points) {
                if (stroke.points.some(p => Math.hypot(p.x - pos.x, p.y - pos.y) < eraseRadius + (stroke.lineWidth / 2))) {
                    stroke.isErasing = true;
                }
            } else { 
                if (isPointInBox(pos, box)) stroke.isErasing = true;
            }
            if (wasErasing !== stroke.isErasing) {
                changed = true;
                // MODIFIED: Invalidate GPU buffers so color/alpha updates
                stroke.gpuData = null;
            }
        });
        if (changed) redrawRequested = true;
    }

    function applySmoothing(points, factor) {
        const normalizedFactor = ((factor - 1) / 99) * 0.95;
        if (normalizedFactor <= 0 || points.length < 3) return points;
        const smoothed = [points[0]];
        for (let i = 1; i < points.length - 1; i++) {
            const p0 = points[i-1], p1 = points[i], p2 = points[i+1];
            smoothed.push({
                x: p1.x * (1 - normalizedFactor) + (p0.x + p2.x) / 2 * normalizedFactor,
                y: p1.y * (1 - normalizedFactor) + (p0.y + p2.y) / 2 * normalizedFactor
            });
        }
        smoothed.push(points[points.length - 1]);
        const finalSmoothed = [smoothed[0]];
        for (let i = 1; i < smoothed.length - 1; i++) {
             const p1 = smoothed[i], p2 = smoothed[i+1];
             finalSmoothed.push({x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2});
        }
        finalSmoothed.push(smoothed[smoothed.length-1]);
        return finalSmoothed;
    }

    // --- SELECTION LOGIC ---
    function showSelectionToolbar() {
        if (!selectionToolbar) return;
        const activeLayer = getActiveLayer();
        if (activeLayer && canvasState.selectedStrokes.size > 0) {
            const firstSelectedId = canvasState.selectedStrokes.values().next().value;
            const { stroke: firstSelectedStroke } = findStrokeAndLayer(firstSelectedId);
            if (firstSelectedStroke && firstSelectedStroke.color) {
                $('#selection-color-display').style.backgroundColor = firstSelectedStroke.color;
            } else {
                $('#selection-color-display').style.backgroundColor = 'var(--text-secondary)';
            }
        }
        selectionToolbar.classList.add('visible');
    }

    function hideSelectionToolbar() {
        if (!selectionToolbar) return;
        selectionToolbar.classList.remove('visible');
        $('#selection-color-picker').classList.remove('visible');
    }

    function getStrokeBounds(stroke) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        if (stroke.points) {
            stroke.points.forEach(p => { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); });
        } else {
            minX = Math.min(stroke.x, stroke.x + stroke.width); minY = Math.min(minY, stroke.y + stroke.height);
            maxX = Math.max(stroke.x, stroke.x + stroke.width); maxY = Math.max(maxY, stroke.y + stroke.height);
        }
        const padding = (stroke.lineWidth || 0) / 2;
        return { minX: minX - padding, minY: minY - padding, maxX: maxX + padding, maxY: maxY + padding };
    }
    function isPointInPolygon(point, polygon) {
        let isInside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].x, yi = polygon[i].y, xj = polygon[j].x, yj = polygon[j].y;
            if (((yi > point.y) !== (yj > point.y)) && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) isInside = !isInside;
        }
        return isInside;
    }
    function selectStrokesInLasso() {
        const activeLayer = getActiveLayer(); if (!activeLayer) return;
        canvasState.selectedStrokes.clear();
        activeLayer.strokes.forEach(stroke => {
            if (stroke.points) {
                if (stroke.points.some(p => isPointInPolygon(p, canvasState.lassoPoints))) {
                    canvasState.selectedStrokes.add(stroke.id);
                }
            } else {
                const bounds = getStrokeBounds(stroke);
                const corners = [ {x: bounds.minX, y: bounds.minY}, {x: bounds.maxX, y: bounds.minY}, {x: bounds.maxX, y: bounds.maxY}, {x: bounds.minX, y: bounds.maxY} ];
                if (corners.some(p => isPointInPolygon(p, canvasState.lassoPoints))) {
                    canvasState.selectedStrokes.add(stroke.id);
                }
            }
        });
        canvasState.lassoPoints = [];
        calculateSelectionBox();
    }
    function calculateSelectionBox() {
        const activeLayer = getActiveLayer();
        if (!activeLayer || canvasState.selectedStrokes.size === 0) {
            canvasState.selectionBox = null; 
            hideSelectionToolbar();
            return;
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        activeLayer.strokes.forEach(stroke => {
            if (canvasState.selectedStrokes.has(stroke.id)) {
                const b = getStrokeBounds(stroke);
                minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
                maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
            }
        });
        canvasState.selectionBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        showSelectionToolbar();
    }
    
    function getResizeHandles(box) {
        if (!box) return [];
        return [
            { x: box.x, y: box.y, cursor: 'nwse-resize', type: 'tl' },
            { x: box.x + box.width, y: box.y, cursor: 'nesw-resize', type: 'tr' },
            { x: box.x, y: box.y + box.height, cursor: 'nesw-resize', type: 'bl' },
            { x: box.x + box.width, y: box.y + box.height, cursor: 'nwse-resize', type: 'br' },
        ];
    }
    
    function getResizeHandleUnderCursor(pos) {
        const handleSize = 1.5;
        if (!canvasState.selectionBox) return null;
        return getResizeHandles(canvasState.selectionBox).find(h => 
            pos.x >= h.x - handleSize / 2 && pos.x <= h.x + handleSize / 2 &&
            pos.y >= h.y - handleSize / 2 && pos.y <= h.y + handleSize / 2
        );
    }
    function isPointInBox(point, box) { return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height; }
    
    function updateCursor() {
        if (canvasState.isPanning) canvas.style.cursor = 'grabbing';
        else if (canvasState.activeTool === 'laser') canvas.style.cursor = 'none';
        else if (canvasState.activeTool === 'pan') canvas.style.cursor = 'grab';
        else canvas.style.cursor = 'crosshair';
    }

    function moveSelection(dx, dy) {
        const activeLayer = getActiveLayer(); if (!activeLayer) return;
        activeLayer.strokes.forEach(stroke => {
            if (canvasState.selectedStrokes.has(stroke.id)) {
                if(stroke.points) { stroke.points.forEach(p => { p.x += dx; p.y += dy; }); } 
                else { stroke.x += dx; stroke.y += dy; }
                // Invalidate GPU buffers (position changed)
                stroke.gpuData = null;
            }
        });
        canvasState.selectionBox.x += dx;
        canvasState.selectionBox.y += dy;
    }
    function resizeSelection(dx, dy) {
        const activeLayer = getActiveLayer(); if (!activeLayer) return;
        const box = canvasState.selectionBox;
        const handleType = canvasState.resizeHandle.type;
        const originalBox = { ...box };
        let scaleX = 1, scaleY = 1, originX = 0, originY = 0;

        if (handleType.includes('r')) { box.width += dx; originX = originalBox.x; }
        if (handleType.includes('l')) { box.width -= dx; box.x += dx; originX = originalBox.x + originalBox.width; }
        if (handleType.includes('b')) { box.height += dy; originY = originalBox.y; }
        if (handleType.includes('t')) { box.height -= dy; box.y += dy; originY = originalBox.y + originalBox.height; }

        if (Math.abs(originalBox.width) > 0.001) scaleX = box.width / originalBox.width;
        if (Math.abs(originalBox.height) > 0.001) scaleY = box.height / originalBox.height;
        
        activeLayer.strokes.forEach(stroke => {
            if (canvasState.selectedStrokes.has(stroke.id)) {
                const transformFn = (p) => ({ x: originX + (p.x - originX) * scaleX, y: originY + (p.y - originY) * scaleY });
                if(stroke.points) { stroke.points = stroke.points.map(transformFn); } 
                else {
                    const newCoords = transformFn({x: stroke.x, y: stroke.y});
                    stroke.x = newCoords.x; stroke.y = newCoords.y;
                    stroke.width *= scaleX; stroke.height *= scaleY;
                }
                stroke.lineWidth *= Math.min(Math.abs(scaleX), Math.abs(scaleY));
                // Invalidate GPU buffers (geometry changed)
                stroke.gpuData = null;
            }
        });
    }
    
    function setActiveTool(newTool) {
        canvasState.activeTool = newTool;
        canvasState.activeSettingWedge = null;
        $('#settings-popup').classList.remove('visible');
        $('#pan-tool-btn').classList.toggle('active', newTool === 'pan');
        if (window.updateActiveWedge) window.updateActiveWedge();
        updateCursor();
        updateSettingsUI();
    }

    // --- RADIAL TOOLBAR --- (Unchanged)
    function initRadialToolbar() {
        const radialToolbar = $('#radial-toolbar');
        const tools = [
            { id: 'pen', icon: 'edit-3', name: 'Pen' }, { id: 'highlighter', icon: 'edit', name: 'Highlighter' },
            { id: 'eraser', icon: 'trash', name: 'Eraser' }, { id: 'lasso', icon: 'crop', name: 'Lasso' },
            { id: 'center-content', icon: 'compass', name: 'Find Content' }, { id: 'undo', icon: 'corner-up-left', name: 'Undo' },
            { id: 'redo', icon: 'corner-up-right', name: 'Redo' }, { id: 'laser', icon: 'radio', name: 'Laser Pointer' },
        ];
        const settingsTools = [
            { id: 'size-setting', icon: 'git-commit', name: 'Size' },
            { id: 'opacity-setting', icon: 'droplet', name: 'Opacity' },
            { id: 'smoothness-setting', icon: 'wind', name: 'Smoothness' },
        ];
        const polarToCartesian = (cx, cy, r, angle) => ({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
        const createWedgePath = (cx, cy, ir, or, sa, ea) => {
            const p1 = polarToCartesian(cx, cy, or, sa), p2 = polarToCartesian(cx, cy, or, ea);
            const p3 = polarToCartesian(cx, cy, ir, ea), p4 = polarToCartesian(cx, cy, ir, sa);
            return `M ${p1.x} ${p1.y} A ${or} ${or} 0 ${ea - sa > Math.PI ? 1:0} 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${ir} ${ir} 0 ${ea - sa > Math.PI ? 1:0} 0 ${p4.x} ${p4.y} Z`;
        };
        radialToolbar.querySelector('svg')?.remove();
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute('viewBox', '0 0 200 200');
        const createRing = (toolsArray, innerR, outerR) => {
            const anglePerWedge = (2 * Math.PI) / toolsArray.length;
            toolsArray.forEach((tool, i) => {
                const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
                g.classList.add('tool-group'); g.dataset.toolId = tool.id;
                const sa = i * anglePerWedge - (Math.PI / 2), ea = (i + 1) * anglePerWedge - (Math.PI / 2);
                const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
                path.setAttribute('d', createWedgePath(100, 100, innerR, outerR, sa, ea));
                path.classList.add('tool-wedge');
                const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
                title.textContent = tool.name;
                g.append(title, path);
                const p1 = polarToCartesian(100, 100, innerR, sa), p2 = polarToCartesian(100, 100, outerR, sa);
                const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
                line.setAttribute('x1', p1.x); line.setAttribute('y1', p1.y); line.setAttribute('x2', p2.x); line.setAttribute('y2', p2.y);
                line.classList.add('tool-separator');
                g.appendChild(line);
                const iconPos = polarToCartesian(100, 100, (innerR + outerR) / 2, (sa + ea) / 2);
                const tempDiv = document.createElement('div');
                const iconSize = (outerR - innerR) * 0.45;
                tempDiv.innerHTML = feather.icons[tool.icon].toSvg({ class: 'tool-icon', x: iconPos.x - iconSize / 2, y: iconPos.y - iconSize / 2, width: iconSize, height: iconSize });
                g.appendChild(tempDiv.firstChild);
                svg.appendChild(g);
            });
        };
        const createSeparator = (r) => {
            const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            circle.setAttribute('cx', 100); circle.setAttribute('cy', 100); circle.setAttribute('r', r); circle.classList.add('ring-separator');
            return circle;
        };
        createRing(tools, 62, 100); 
        createRing(settingsTools, 24, 62);
        svg.append(createSeparator(62), createSeparator(24));
        radialToolbar.appendChild(svg);
        
        window.updateActiveWedge = () => {
            svg.querySelectorAll('.tool-wedge').forEach(p => p.classList.remove('active'));
            
            const activeToolWedge = svg.querySelector(`.tool-group[data-tool-id="${canvasState.activeTool}"] .tool-wedge`);
            if (activeToolWedge) activeToolWedge.classList.add('active');

            if (canvasState.activeSettingWedge) {
                const activeSettingWedgeEl = svg.querySelector(`.tool-group[data-tool-id="${canvasState.activeSettingWedge}"] .tool-wedge`);
                if (activeSettingWedgeEl) activeSettingWedgeEl.classList.add('active');
            }
        }

        svg.addEventListener('click', (e) => {
            const toolId = e.target.closest('.tool-group')?.dataset.toolId;
            if (!toolId) return;

            const settingsPopup = $('#settings-popup');
            
            if (toolId === 'undo') { undo(); return; }
            if (toolId === 'redo') { redo(); return; }
            if (toolId === 'center-content') { centerCanvasContent(); return; }
            
            if (toolId === 'size-setting' || toolId === 'opacity-setting' || toolId === 'smoothness-setting') {
                updateSettingsUI(); 
                
                const tool = canvasState.activeTool;
                const settings = brushSettings[tool];
                const hasSettings = settings?.hasOwnProperty('lineWidth') || settings?.hasOwnProperty('opacity') || settings?.hasOwnProperty('smoothness');

                if (hasSettings) {
                    const wasVisible = settingsPopup.classList.contains('visible');
                    if (wasVisible && canvasState.activeSettingWedge === toolId) {
                        settingsPopup.classList.remove('visible');
                        canvasState.activeSettingWedge = null;
                    } else {
                        settingsPopup.classList.add('visible');
                        canvasState.activeSettingWedge = toolId;
                    }
                } else {
                    settingsPopup.classList.remove('visible');
                    canvasState.activeSettingWedge = null;
                }
                window.updateActiveWedge();
                return;
            }
            
            settingsPopup.classList.remove('visible');
            canvasState.activeSettingWedge = null;
            setActiveTool(toolId);
        });

        window.updateActiveWedge(); updateSettingsUI();
        $('#color-display').style.backgroundColor = brushSettings[canvasState.activeTool]?.color || '#FFFFFF';
        $('#color-display-wrapper').addEventListener('click', (e) => { e.stopPropagation(); $('#simple-color-picker').classList.toggle('visible'); });
    }
    
    function updateSettingsUI() {
        const tool = canvasState.activeTool;
        const settings = brushSettings[tool];
        const show = (el, condition) => el.style.display = condition ? 'flex' : 'none';
        
        show($('#pen-size-setting'), settings?.hasOwnProperty('lineWidth'));
        show($('#opacity-setting'), settings?.hasOwnProperty('opacity'));
        show($('#smoothness-setting'), settings?.hasOwnProperty('smoothness'));

        if (!settings) return;

        if (settings.hasOwnProperty('lineWidth')) {
            $('#pen-size-slider').value = settings.lineWidth;
            $('#pen-size-value').textContent = settings.lineWidth;
        }
        if (settings.hasOwnProperty('opacity')) {
            $('#opacity-slider').value = settings.opacity;
            $('#opacity-value').textContent = settings.opacity;
        }
        if (settings.hasOwnProperty('smoothness')) {
            $('#smoothness-slider').value = settings.smoothness;
            $('#smoothness-value').textContent = settings.smoothness;
        }
        if(settings.hasOwnProperty('color')) {
            $('#color-display').style.backgroundColor = settings.color;
        }
    }

    // --- ANIMATION & VIEWPORT ---
    function animateView() {
        let needsRedraw = redrawRequested;
        redrawRequested = false;
        
        const panDist = Math.hypot(viewState.targetPanOffset.x - viewState.panOffset.x, viewState.targetPanOffset.y - viewState.panOffset.y);
        const scaleDist = Math.abs(viewState.targetScale - viewState.scale);

        if (panDist > 0.01 || scaleDist > 0.0001) {
            viewState.panOffset.x = lerp(viewState.panOffset.x, viewState.targetPanOffset.x, 0.25);
            viewState.panOffset.y = lerp(viewState.panOffset.y, viewState.targetPanOffset.y, 0.25);
            viewState.scale = lerp(viewState.scale, viewState.targetScale, 0.25);
            // Show total zoom: FLOOR_BASE^floorIndex * localZoom
            const totalZoom = Math.pow(FLOOR_BASE, viewState.currentFloor.index) * viewState.scale;
            if (totalZoom >= 1e9) {
                $('#zoom-level-display').textContent = `${(totalZoom / 1e9).toFixed(1)}B%`;
            } else if (totalZoom >= 1e6) {
                $('#zoom-level-display').textContent = `${(totalZoom / 1e6).toFixed(1)}M%`;
            } else if (totalZoom >= 1e4) {
                $('#zoom-level-display').textContent = `${(totalZoom / 1e3).toFixed(1)}K%`;
            } else {
                $('#zoom-level-display').textContent = `${Math.round(totalZoom * 100)}%`;
            }
            needsRedraw = true;
        }

        if (canvasState.activeTool === 'laser' && (canvasState.laserPoints.length > 0 || canvasState.isDrawing)) {
            needsRedraw = true;
            const now = Date.now();
            const fadeDuration = 500;
            canvasState.laserPoints = canvasState.laserPoints.filter(p => now - p.time < fadeDuration);
        }

        if (needsRedraw && renderer) {
            const canvasData = getActiveCardCanvasState();
            const layers = (canvasData && canvasData.layers) ? canvasData.layers : [];
            
            renderer.render(
                viewState,
                layers,
                canvasState.laserPoints,
                canvasState.isLassoing ? canvasState.lassoPoints : [],
                canvasState.selectionBox,
                canvasState.tempShape
            );
        }
        
        requestAnimationFrame(animateView);
    }
    
    function centerCanvasContent() {
        const canvasData = getActiveCardCanvasState();
        if (!canvasData) return;
        const allStrokes = canvasData.layers.flatMap(l => l.isVisible ? l.strokes : []);
        if (allStrokes.length === 0) return;

        const bounds = allStrokes.reduce((acc, s) => {
            const b = getStrokeBounds(s);
            return { minX: Math.min(acc.minX, b.minX), minY: Math.min(acc.minY, b.minY), maxX: Math.max(acc.maxX, b.maxX), maxY: Math.max(acc.maxY, b.maxY) };
        }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
        
        const contentWidth = bounds.maxX - bounds.minX;
        const contentHeight = bounds.maxY - bounds.minY;
        if (contentWidth < 1 || contentHeight < 1) return;

        const scaleX = canvas.width / (contentWidth + 100);
        const scaleY = canvas.height / (contentHeight + 100);
        viewState.targetScale = Math.min(scaleX, scaleY, 2);
        viewState.targetPanOffset.x = canvas.width / 2 - (bounds.minX + contentWidth / 2) * viewState.targetScale;
        viewState.targetPanOffset.y = canvas.height / 2 - (bounds.minY + contentHeight / 2) * viewState.targetScale;
        
        redrawRequested = true;
    }

    // --- LAYERS LOGIC ---
    function renderLayersPanel() {
        const canvasData = getActiveCardCanvasState();
        const listEl = $('#layers-list');
        if (!canvasData || !listEl) return;
        
        listEl.innerHTML = canvasData.layers.map(layer => `
            <li class="layer-item ${layer.id === canvasData.activeLayerId ? 'active' : ''} ${!layer.isVisible ? 'hidden' : ''}" data-layer-id="${layer.id}">
                <button class="control-button layer-visibility" title="Toggle Visibility"><i data-feather="${layer.isVisible ? 'eye' : 'eye-off'}"></i></button>
                <span class="layer-name" contenteditable="true" spellcheck="false">${layer.name}</span>
                <button class="control-button delete-layer-btn" title="Delete Layer"><i data-feather="trash"></i></button>
            </li>
        `).join('');
        feather.replace();
    }
    
    function addLayersEventListeners() {
        const panel = $('#layers-panel');
        
        $('#add-layer-btn').addEventListener('click', () => {
            const canvasData = getActiveCardCanvasState();
            if (!canvasData) return;
            const newLayer = { id: getUniqueId(), name: `Layer ${canvasData.layers.length + 1}`, isVisible: true, strokes: [] };
            canvasData.layers.push(newLayer);
            canvasData.activeLayerId = newLayer.id;
            saveData();
            renderLayersPanel();
            redrawRequested = true;
        });

        panel.addEventListener('click', async (e) => {
            const layerItem = e.target.closest('.layer-item');
            if (!layerItem) return;
            
            const layerId = parseFloat(layerItem.dataset.layerId);
            const canvasData = getActiveCardCanvasState();
            if (!canvasData) return;
            
            if (e.target.closest('.delete-layer-btn')) {
                if (canvasData.layers.length <= 1) {
                    Modal.confirm("Cannot Delete", "You must have at least one layer.").then(() => {});
                    return;
                }
                if (await Modal.confirm("Delete Layer?", "Are you sure you want to delete this layer and all its content? This cannot be undone.")) {
                    // Cleanup buffers before deleting
                    const layerToDelete = canvasData.layers.find(l => l.id === layerId);
                    if (layerToDelete) {
                        layerToDelete.strokes.forEach(s => { if(s.gpuData) { s.gpuData.vertexBuffer.destroy(); s.gpuData.indexBuffer.destroy(); } });
                    }
                    canvasData.layers = canvasData.layers.filter(l => l.id !== layerId);
                    if (canvasData.activeLayerId === layerId) {
                        canvasData.activeLayerId = canvasData.layers[canvasData.layers.length - 1].id;
                    }
                    saveData();
                    renderLayersPanel();
                    redrawRequested = true;
                }
            } else if (e.target.closest('.layer-visibility')) {
                const layer = canvasData.layers.find(l => l.id === layerId);
                if (layer) {
                    layer.isVisible = !layer.isVisible;
                    saveData();
                    renderLayersPanel();
                    redrawRequested = true;
                }
            } else if (!e.target.matches('.layer-name')) {
                canvasData.activeLayerId = layerId;
                canvasState.selectedStrokes.clear();
                canvasState.selectionBox = null;
                hideSelectionToolbar();
                saveData();
                renderLayersPanel();
                redrawRequested = true;
            }
        });
        
        panel.addEventListener('input', e => {
            const nameSpan = e.target.closest('.layer-name');
            if (nameSpan) {
                const layerId = parseFloat(nameSpan.closest('.layer-item').dataset.layerId);
                const canvasData = getActiveCardCanvasState();
                const layer = canvasData.layers.find(l => l.id === layerId);
                if (layer) {
                    layer.name = nameSpan.textContent;
                    saveData();
                }
            }
        });
    }

    // --- INITIALIZATION ---
    async function initCanvas() {
        const container = $('#canvas-view');
        
        if (!renderer) {
            try {
                renderer = new WebGPURenderer(canvas);
                await renderer.init();
            } catch (err) {
                console.error("Failed to initialize WebGPU:", err);
                Modal.confirm("Rendering Error", "Could not initialize WebGPU. Your browser might not support it, or it might be disabled. The canvas will not work.")
                    .then(() => {});
                return; 
            }
        }
        
        renderer.resize(container.clientWidth, container.clientHeight);

        if (!canvas.dataset.initialized) {
            canvas.addEventListener('pointerdown', handleCanvasPointerDown);
            canvas.addEventListener('pointermove', handleCanvasPointerMove);
            canvas.addEventListener('pointerup', handleCanvasPointerUp);
            canvas.addEventListener('pointercancel', handleCanvasPointerUp);
            canvas.addEventListener('pointerleave', handleCanvasPointerUp);
            canvas.addEventListener('contextmenu', e => e.preventDefault());
            canvas.addEventListener('wheel', handleWheel, { passive: false });

            $('#back-to-revisions-btn').addEventListener('click', () => switchView('revisions'));
            $('#pan-tool-btn').addEventListener('click', () => setActiveTool(canvasState.activeTool === 'pan' ? 'pen' : 'pan'));

            $('#layers-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#layers-panel').classList.toggle('visible'); });

            $('#pen-size-slider').addEventListener('input', e => { brushSettings[canvasState.activeTool].lineWidth = +e.target.value; $('#pen-size-value').textContent = e.target.value; });
            $('#opacity-slider').addEventListener('input', e => { brushSettings[canvasState.activeTool].opacity = +e.target.value; $('#opacity-value').textContent = e.target.value; });
            $('#smoothness-slider').addEventListener('input', e => { brushSettings[canvasState.activeTool].smoothness = +e.target.value; $('#smoothness-value').textContent = e.target.value; });

            $$('.zoom-btn').forEach(btn => btn.addEventListener('click', () => {
                 const zoomFactor = btn.dataset.zoom === 'in' ? 1.4 : 1 / 1.4;
                 const center = { x: canvas.width / 2, y: canvas.height / 2 };
                 const oldScale = viewState.targetScale;
                 const newTargetScale = Math.max(0.01, oldScale * zoomFactor);
                 const worldPos = { x: (center.x - viewState.targetPanOffset.x) / oldScale, y: (center.y - viewState.targetPanOffset.y) / oldScale };
                 viewState.targetPanOffset = { x: center.x - worldPos.x * newTargetScale, y: center.y - worldPos.y * newTargetScale };
                 viewState.targetScale = newTargetScale;
                 checkFloorTransitions();
                 redrawRequested = true; 
            }));

            window.addEventListener('resize', () => {
                const newWidth = container.clientWidth;
                const newHeight = container.clientHeight;
                if (renderer) renderer.resize(newWidth, newHeight); 
                redrawRequested = true;
            });

            const colors = ['#F8FAFC', '#EF4444', '#F97316', '#EAB308', '#84CC16', '#22C55E', '#14B8A6', '#06B6D4', '#3B82F6', '#6366F1', '#8B5CF6', '#D946EF', '#EC4899', '#78716C'];
            
            const simpleColorPicker = $('#simple-color-picker');
            simpleColorPicker.innerHTML = colors.map(c => `<div class="color-swatch" style="background-color: ${c}" data-color="${c}"></div>`).join('');
            simpleColorPicker.addEventListener('click', (e) => {
                const color = e.target.closest('.color-swatch')?.dataset.color;
                if (color && brushSettings[canvasState.activeTool]?.hasOwnProperty('color')) {
                    brushSettings[canvasState.activeTool].color = color;
                    $('#color-display').style.backgroundColor = color;
                    simpleColorPicker.classList.remove('visible');
                }
            });

            const selectionColorPicker = $('#selection-color-picker');
            selectionColorPicker.innerHTML = colors.map(c => `<div class="color-swatch" style="background-color: ${c}" data-color="${c}"></div>`).join('');
            
            $('#selection-delete-btn').addEventListener('click', () => {
                const activeLayer = getActiveLayer();
                if (!activeLayer || canvasState.selectedStrokes.size === 0) return;

                const strokesToDelete = JSON.parse(JSON.stringify(
                    activeLayer.strokes.filter(s => canvasState.selectedStrokes.has(s.id))
                ));

                if (strokesToDelete.length > 0) {
                    addHistoryAction({ type: 'REMOVE', strokes: strokesToDelete, layerId: activeLayer.id });
                    // Cleanup GPU buffers before removal
                    activeLayer.strokes.forEach(s => { if(canvasState.selectedStrokes.has(s.id) && s.gpuData) { s.gpuData.vertexBuffer.destroy(); s.gpuData.indexBuffer.destroy(); } });
                    
                    activeLayer.strokes = activeLayer.strokes.filter(s => !canvasState.selectedStrokes.has(s.id));
                    
                    canvasState.selectedStrokes.clear();
                    canvasState.selectionBox = null;
                    hideSelectionToolbar();
                    saveData();
                    redrawRequested = true;
                }
            });

            $('#selection-color-wrapper').addEventListener('click', (e) => {
                e.stopPropagation();
                selectionColorPicker.classList.toggle('visible');
            });

            selectionColorPicker.addEventListener('click', (e) => {
                const color = e.target.closest('.color-swatch')?.dataset.color;
                if (!color) return;
                
                const activeLayer = getActiveLayer();
                if (!activeLayer || canvasState.selectedStrokes.size === 0) return;

                storePreModificationState();

                activeLayer.strokes.forEach(stroke => {
                    if (canvasState.selectedStrokes.has(stroke.id) && stroke.hasOwnProperty('color')) {
                        stroke.color = color;
                        // Invalidate GPU buffers (color changed)
                        stroke.gpuData = null;
                    }
                });

                const postModificationStrokes = JSON.parse(JSON.stringify(
                    activeLayer.strokes.filter(s => canvasState.selectedStrokes.has(s.id))
                ));
                
                if (preModificationStrokes && JSON.stringify(preModificationStrokes) !== JSON.stringify(postModificationStrokes)) {
                    addHistoryAction({ type: 'MODIFY', before: preModificationStrokes, after: postModificationStrokes, layerId: activeLayer.id });
                }
                preModificationStrokes = null;

                $('#selection-color-display').style.backgroundColor = color;
                selectionColorPicker.classList.remove('visible');
                saveData();
                redrawRequested = true;
            });

            document.addEventListener('click', (e) => {
                const settingsPopup = $('#settings-popup');
                const layersPanel = $('#layers-panel');
                const radialColorPicker = $('#simple-color-picker');
                const selectionColorPicker = $('#selection-color-picker');

                const isRadialClick = e.target.closest('#radial-toolbar') || 
                                      e.target.closest('#simple-color-picker') || 
                                      e.target.closest('#settings-popup');

                if (settingsPopup.classList.contains('visible') && !isRadialClick) {
                    settingsPopup.classList.remove('visible');
                    canvasState.activeSettingWedge = null;
                    if(window.updateActiveWedge) window.updateActiveWedge(); 
                }

                if (layersPanel.classList.contains('visible') && !layersPanel.contains(e.target) && !e.target.closest('#layers-btn')) {
                    layersPanel.classList.remove('visible');
                }

                if (radialColorPicker.classList.contains('visible') && !isRadialClick) {
                    radialColorPicker.classList.remove('visible');
                }

                if (selectionColorPicker.classList.contains('visible') && !selectionColorPicker.contains(e.target) && !e.target.closest('#selection-color-wrapper')) {
                    selectionColorPicker.classList.remove('visible');
                }
            });

            addLayersEventListeners();
            initRadialToolbar();
            
            animateView();
            canvas.dataset.initialized = 'true';
        }
        
        const canvasData = getActiveCardCanvasState();
        if (canvasData) {
            viewState.scale = canvasData.scale || 1;
            viewState.panOffset = canvasData.panOffset || { x: 0, y: 0 };
            viewState.targetScale = viewState.scale;
            viewState.targetPanOffset = { ...viewState.panOffset };
            // Restore floor tree
            if (canvasData.floorTree) {
                const rootFloor = ZoomFloor.fromJSON(canvasData.floorTree);
                const targetIndex = canvasData.currentFloorIndex || 0;
                let floor = rootFloor;
                while (floor && floor.index < targetIndex && floor.child) floor = floor.child;
                viewState.currentFloor = floor;
            } else {
                viewState.currentFloor = new ZoomFloor(0);
            }
            const totalZoom = Math.pow(FLOOR_BASE, viewState.currentFloor.index) * viewState.scale;
            if (totalZoom >= 1e6) {
                $('#zoom-level-display').textContent = `${(totalZoom / 1e6).toFixed(1)}M%`;
            } else if (totalZoom >= 1e4) {
                $('#zoom-level-display').textContent = `${(totalZoom / 1e3).toFixed(1)}K%`;
            } else {
                $('#zoom-level-display').textContent = `${Math.round(totalZoom * 100)}%`;
            }
            renderLayersPanel();
        }
        setActiveTool('pen');
        redrawRequested = true;
    }

    // --- APP START ---
    loadData();
    switchView('revisions');
});
