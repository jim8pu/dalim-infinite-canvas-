import { Point, Stroke, Box } from '../core/types';

/** Linear interpolation function */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Generator for universally unique system identifiers based on epoch offsets */
export const getUniqueId = (): number => Date.now() + Math.random();

/** Converts polar coordinate mapping to continuous cartesian plotting space */
export const polarToCartesian = (cx: number, cy: number, r: number, angle: number): Point => ({
  x: cx + r * Math.cos(angle),
  y: cy + r * Math.sin(angle)
});

/** SVG arc primitive generator bridging two bounding angle spans */
export const createWedgePath = (cx: number, cy: number, ir: number, or: number, sa: number, ea: number): string => {
  const p1 = polarToCartesian(cx, cy, or, sa);
  const p2 = polarToCartesian(cx, cy, or, ea);
  const p3 = polarToCartesian(cx, cy, ir, ea);
  const p4 = polarToCartesian(cx, cy, ir, sa);
  const largeArcFlag = ea - sa > Math.PI ? 1 : 0;
  
  return `M ${p1.x} ${p1.y} A ${or} ${or} 0 ${largeArcFlag} 1 ${p2.x} ${p2.y} L ${p3.x} ${p3.y} A ${ir} ${ir} 0 ${largeArcFlag} 0 ${p4.x} ${p4.y} Z`;
};

/** Evaluates whether arbitrary Point lies boundary-inclusive across a ray-traced Polygon surface area */
export function isPointInPolygon(point: Point, polygon: Point[]): boolean {
  let isInside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if (((yi > point.y) !== (yj > point.y)) && 
        (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
      isInside = !isInside;
    }
  }
  return isInside;
}

/** Determines rectangular inclusion algorithm */
export function isPointInBox(point: Point, box: Box): boolean {
  return point.x >= box.x && point.x <= box.x + box.width && 
         point.y >= box.y && point.y <= box.y + box.height;
}

/** Parses raw rendering shapes into normalized spatial bounding-boxes */
export function getStrokeBounds(stroke: Stroke): Box & { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  
  if (stroke.points && stroke.points.length > 0) {
    stroke.points.forEach(p => { 
      minX = Math.min(minX, p.x); 
      minY = Math.min(minY, p.y); 
      maxX = Math.max(maxX, p.x); 
      maxY = Math.max(maxY, p.y); 
    });
  } else {
    const sx = stroke.x || 0, sy = stroke.y || 0, sw = stroke.width || 0, sh = stroke.height || 0;
    minX = Math.min(sx, sx + sw); 
    minY = Math.min(sy, sy + sh);
    maxX = Math.max(sx, sx + sw); 
    maxY = Math.max(sy, sy + sh);
  }
  
  const padding = (stroke.lineWidth || 0) / 2;
  return { 
    minX: minX - padding, 
    minY: minY - padding, 
    maxX: maxX + padding, 
    maxY: maxY + padding,
    x: minX - padding,
    y: minY - padding,
    width: (maxX + padding) - (minX - padding),
    height: (maxY + padding) - (minY - padding)
  };
}
