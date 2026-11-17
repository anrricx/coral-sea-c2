import type { HexCoord } from './types';

// Flat-top hexes, "odd-q" vertical layout (odd columns shoved down half a hex).

export const HEX_SIZE = 40; // centre → corner, in SVG units
export const HEX_W = HEX_SIZE * 2;
export const HEX_H = Math.sqrt(3) * HEX_SIZE;

export const key = (h: HexCoord) => `${h.col},${h.row}`;
export const sameHex = (a: HexCoord, b: HexCoord) => a.col === b.col && a.row === b.row;

export function hexToPixel(h: HexCoord): { x: number; y: number } {
  const x = HEX_SIZE + h.col * HEX_SIZE * 1.5;
  const y = HEX_H / 2 + h.row * HEX_H + (h.col & 1 ? HEX_H / 2 : 0);
  return { x, y };
}

export function mapPixelSize(cols: number, rows: number) {
  return {
    width: HEX_SIZE * 1.5 * (cols - 1) + HEX_W,
    height: HEX_H * rows + HEX_H / 2,
  };
}

export function hexCorners(cx: number, cy: number, size = HEX_SIZE): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i);
    pts.push(`${(cx + size * Math.cos(a)).toFixed(2)},${(cy + size * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

function toCube(h: HexCoord) {
  const x = h.col;
  const z = h.row - (h.col - (h.col & 1)) / 2;
  return { x, y: -x - z, z };
}

export function hexDistance(a: HexCoord, b: HexCoord): number {
  const ac = toCube(a);
  const bc = toCube(b);
  return Math.max(Math.abs(ac.x - bc.x), Math.abs(ac.y - bc.y), Math.abs(ac.z - bc.z));
}

const ODD_Q_DIRS = [
  // even columns
  [
    [1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [0, 1],
  ],
  // odd columns
  [
    [1, 1], [1, 0], [0, -1], [-1, 0], [-1, 1], [0, 1],
  ],
];

export function neighbors(h: HexCoord, cols: number, rows: number): HexCoord[] {
  const dirs = ODD_Q_DIRS[h.col & 1];
  const out: HexCoord[] = [];
  for (const [dc, dr] of dirs) {
    const n = { col: h.col + dc, row: h.row + dr };
    if (inBounds(n, cols, rows)) out.push(n);
  }
  return out;
}

export function inBounds(h: HexCoord, cols: number, rows: number): boolean {
  return Number.isInteger(h.col) && Number.isInteger(h.row) && h.col >= 0 && h.row >= 0 && h.col < cols && h.row < rows;
}

export function hexesWithin(center: HexCoord, radius: number, cols: number, rows: number): HexCoord[] {
  const out: HexCoord[] = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const h = { col: c, row: r };
      if (hexDistance(center, h) <= radius) out.push(h);
    }
  }
  return out;
}
