import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

export interface ArtifactInventory {
  path: string;
  fileCount: number;
  totalBytes: number;
}

export interface ThreeUnityInventory {
  path: string;
  bytes: number;
  version: number | null;
  nodes: number;
  meshes: number;
  materials: number;
  textures: number;
  animations: number;
  skins: number;
  vertices: number;
  indices: number;
  triangles: number;
  morphTargets: number;
  warnings: number;
}

export async function inventoryArtifact(path: string): Promise<ArtifactInventory> {
  const absolutePath = resolve(path);
  const root = await stat(absolutePath);
  if (root.isFile()) return { path: absolutePath, fileCount: 1, totalBytes: root.size };
  if (!root.isDirectory()) throw new Error(`Artifact path is neither a file nor a directory: ${absolutePath}`);
  const totals = { fileCount: 0, totalBytes: 0 };
  await visitDirectory(absolutePath, totals);
  return { path: absolutePath, ...totals };
}

export async function inventoryThreeUnity(path: string): Promise<ThreeUnityInventory> {
  const absolutePath = resolve(path);
  const raw = await readFile(absolutePath, "utf8");
  const document = JSON.parse(raw) as Record<string, unknown>;
  const meshes = arrayOfRecords(document.meshes);
  let vertices = 0;
  let indices = 0;
  let triangles = 0;
  let morphTargets = 0;
  for (const mesh of meshes) {
    const positions = numberArray(mesh.positions);
    const meshIndices = numberArray(mesh.indices);
    vertices += Math.floor(positions.length / 3);
    indices += meshIndices.length;
    triangles += meshIndices.length > 0 ? Math.floor(meshIndices.length / 3) : Math.floor(positions.length / 9);
    const morph = mesh.morphTargets;
    if (Array.isArray(morph)) morphTargets += morph.length;
  }
  return {
    path: absolutePath,
    bytes: Buffer.byteLength(raw),
    version: typeof document.version === "number" ? document.version : null,
    nodes: arrayLength(document.nodes),
    meshes: meshes.length,
    materials: arrayLength(document.materials),
    textures: arrayLength(document.textures),
    animations: arrayLength(document.animations),
    skins: arrayLength(document.skins),
    vertices,
    indices,
    triangles,
    morphTargets,
    warnings: arrayLength(document.warnings),
  };
}

async function visitDirectory(path: string, totals: { fileCount: number; totalBytes: number }): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = resolve(path, entry.name);
    if (entry.isDirectory()) {
      await visitDirectory(childPath, totals);
    } else if (entry.isFile()) {
      const info = await stat(childPath);
      totals.fileCount += 1;
      totals.totalBytes += info.size;
    }
  }
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === "object" && !Array.isArray(entry))
    : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === "number") : [];
}
